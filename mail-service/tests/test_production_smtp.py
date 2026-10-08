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


def test_production_auto_generated_policy_drops_without_storage(test_account, mock_mongo):
    mail = EmailMessage()
    mail["From"] = "sender@example.test"
    mail["To"] = test_account[0]
    mail["Subject"] = "Automated notification"
    mail["Auto-Submitted"] = "auto-generated"
    mail.set_content("Legitimate automated content")
    assert deliver(mail, test_account[0]) == "250 Message accepted"
    assert mock_mongo.messages.count_documents({}) == 0
