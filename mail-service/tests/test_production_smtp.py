import asyncio
from email.message import EmailMessage
from types import SimpleNamespace

import pytest


def deliver(mail, address):
    from app import MailHandler

    envelope = SimpleNamespace(content=mail.as_bytes(), rcpt_tos=[address],
                               mail_from="sender@example.test")
    session = SimpleNamespace(peer=("127.0.0.1", 25000), rcpt_count=1,
                              mail_from="sender@example.test")
    return asyncio.run(MailHandler().handle_DATA(None, session, envelope))


@pytest.mark.parametrize("multipart", [False, True])
def test_unmarked_binary_payload_is_stored(test_account, mock_mongo, multipart):
    address = test_account[0]
    mail = EmailMessage()
    mail["From"] = "sender@example.test"
    mail["To"] = address
    mail["Subject"] = "Binary report"
    binary = EmailMessage()
    binary.set_content(b"binary-report", maintype="application", subtype="zip")
    if multipart:
        mail.set_content("Report attached")
        mail.make_mixed()
        mail.attach(binary)
    else:
        mail.set_content(b"binary-report", maintype="application", subtype="zip")
    assert deliver(mail, address) == "250 Message accepted for delivery"
    stored = mock_mongo.messages.find_one({"subject": "Binary report"})
    assert stored["attachments"][0]["content"] == b"binary-report"
    assert stored["attachments"][0]["content_type"] == "application/zip"


def test_matching_spam_is_stored_in_trash(test_account, mock_mongo, monkeypatch):
    import app

    monkeypatch.setattr(app, "_SMTP_SPAM_TRASH_ENABLED", True)
    monkeypatch.setattr(app, "_SMTP_SPAM_TRASH_SUBJECT_PHRASES", ("spam marker",))
    mail = EmailMessage()
    mail["From"] = "sender@example.test"
    mail["To"] = test_account[0]
    mail["Subject"] = "Spam marker"
    mail.set_content("Test body")
    assert deliver(mail, test_account[0]) == "250 Message accepted for delivery"
    stored = mock_mongo.messages.find_one({"subject": "Spam marker"})
    assert stored["is_deleted"] is True
    assert stored["is_spam"] is True


def _mail(to, sender, subject, **headers):
    mail = EmailMessage()
    mail["From"] = sender
    mail["To"] = to
    mail["Subject"] = subject
    for name, value in headers.items():
        mail[name.replace("_", "-")] = value
    mail.set_content("content")
    return mail


def test_automated_notifications_from_others_are_stored(test_account, mock_mongo):
    mail = _mail(test_account[0], "notifications@github.example", "New issue", Auto_Submitted="auto-generated")
    assert deliver(mail, test_account[0]) == "250 Message accepted for delivery"
    assert mock_mongo.messages.count_documents({}) == 1


@pytest.mark.parametrize("subject, headers", [
    ("Re: hello", {"Auto_Submitted": "auto-replied"}),
    ("Re: hello", {"X_Autoreply": "yes"}),
    ("Re: hello", {"Precedence": "auto_reply"}),
    ("自动回复: hello", {}),
    ("Automatic reply: hello", {}),
])
def test_auto_replies_from_forward_target_are_dropped(test_account, mock_mongo, monkeypatch, subject, headers):
    import app

    monkeypatch.setattr(app, "_LOOPBACK_SENDERS", {"owner@gmail.example"})
    mail = _mail(test_account[0], "Owner <Owner@gmail.example>", subject, **headers)
    assert deliver(mail, test_account[0]) == "250 Message accepted"
    assert mock_mongo.messages.count_documents({}) == 0


def test_ordinary_mail_from_forward_target_is_stored(test_account, mock_mongo, monkeypatch):
    import app

    monkeypatch.setattr(app, "_LOOPBACK_SENDERS", {"owner@gmail.example"})
    mail = _mail(test_account[0], "Owner <owner@gmail.example>", "hello from my gmail", Auto_Submitted="no")
    assert deliver(mail, test_account[0]) == "250 Message accepted for delivery"
    assert mock_mongo.messages.count_documents({}) == 1
