"""Real-world message shapes through MailHandler.handle_DATA.

Each case is raw bytes as a remote MTA would send them, so header and charset
quirks reach the parser unchanged instead of being normalised by EmailMessage.
"""

import asyncio
from email import message_from_bytes, policy
from types import SimpleNamespace

import bson
import pytest

RCPT = "testuser@test.local"


def raw(headers, body=b""):
    lines = [h if isinstance(h, bytes) else h.encode() for h in headers]
    return b"\r\n".join(lines) + b"\r\n\r\n" + body


def multipart(headers, parts, subtype="mixed"):
    body = b""
    for part_headers, part_body in parts:
        body += b"--B\r\n" + raw(part_headers, part_body) + b"\r\n"
    body += b"--B--\r\n"
    return raw(list(headers) + ["MIME-Version: 1.0", f'Content-Type: multipart/{subtype}; boundary="B"'], body)


def deliver(content, peer="203.0.113.9"):
    from app import MailHandler

    envelope = SimpleNamespace(content=content, rcpt_tos=[RCPT], mail_from="sender@example.test")
    session = SimpleNamespace(peer=(peer, 25000), rcpt_count=1, mail_from="sender@example.test")
    return asyncio.run(MailHandler().handle_DATA(None, session, envelope))


def stored(mock_mongo):
    docs = list(mock_mongo.messages.find())
    assert len(docs) == 1
    return docs[0]


BASIC = ["From: Sender <sender@example.test>", f"To: {RCPT}"]

CORPUS = {
    "raw utf-8 headers": raw(
        [b"From: \xe5\xbc\xa0\xe4\xb8\x89 <zs@example.cn>", f"To: {RCPT}".encode(),
         b"Subject: \xe4\xbd\xa0\xe5\xa5\xbd", b"Content-Type: text/plain; charset=utf-8",
         b"Content-Transfer-Encoding: 8bit"],
        "正文".encode()),
    "utf-8 body without charset": raw(BASIC + ["Subject: no charset", "Content-Transfer-Encoding: 8bit"], "正文".encode()),
    "gbk body": raw(BASIC + ["Subject: gbk", "Content-Type: text/plain; charset=gbk",
                             "Content-Transfer-Encoding: 8bit"], "国标编码".encode("gbk")),
    "unknown charset": raw(BASIC + ["Subject: odd", "Content-Type: text/plain; charset=x-no-such-charset"], b"caf\xe9"),
    "bad base64 attachment": multipart(BASIC + ["Subject: bad b64"], [
        (["Content-Type: text/plain"], b"body"),
        (["Content-Type: application/octet-stream; name=x.bin", "Content-Transfer-Encoding: base64"], b"!!!not*base64###"),
    ]),
    "missing boundary": raw(BASIC + ["Subject: broken", "MIME-Version: 1.0", "Content-Type: multipart/mixed"], b"just text"),
    "missing From": raw([f"To: {RCPT}", "Subject: no from"], b"x"),
    "8bit headers inside attached mail": multipart(BASIC + ["Subject: Fwd raw"], [
        (["Content-Type: text/plain"], b"see attached"),
        (["Content-Type: message/rfc822"], raw([b"From: \xe5\xbc\xa0 <a@b.c>", b"Subject: \xe4\xbd\xa0"], b"inner")),
    ]),
}


@pytest.mark.parametrize("name", CORPUS)
def test_corpus_is_accepted_and_storable(test_account, mock_mongo, name):
    assert deliver(CORPUS[name]) == "250 Message accepted for delivery"
    doc = stored(mock_mongo)
    doc.pop("_id")
    bson.encode(doc)  # what the real MongoDB driver does; mongomock would not catch it
    for field in ("subject", "text", "html"):
        assert isinstance(doc[field], str)


def test_raw_utf8_headers_decode(test_account, mock_mongo):
    deliver(CORPUS["raw utf-8 headers"])
    doc = stored(mock_mongo)
    assert doc["from"] == {"address": "zs@example.cn", "name": "张三"}
    assert doc["subject"] == "你好"
    assert doc["text"] == "正文"


def test_encoded_word_headers_decode(test_account, mock_mongo):
    deliver(raw(["From: =?UTF-8?B?5byg5LiJ?= <ZS@Example.CN>", f"To: {RCPT}", "Subject: =?UTF-8?B?5L2g5aW9?="], b"hi"))
    doc = stored(mock_mongo)
    assert doc["from"] == {"address": "zs@example.cn", "name": "张三"}
    assert doc["subject"] == "你好"


def test_utf8_body_without_declared_charset_is_not_mangled(test_account, mock_mongo):
    deliver(CORPUS["utf-8 body without charset"])
    assert stored(mock_mongo)["text"] == "正文"


def test_declared_gbk_body_decodes(test_account, mock_mongo):
    deliver(CORPUS["gbk body"])
    assert stored(mock_mongo)["text"] == "国标编码"


def test_attachment_only_mail_without_subject_is_accepted(test_account, mock_mongo):
    content = multipart(BASIC, [
        (["Content-Type: application/pdf", "Content-Disposition: attachment; filename=scan.pdf",
          "Content-Transfer-Encoding: base64"], b"JVBERi0xLjQ="),
    ])
    assert deliver(content) == "250 Message accepted for delivery"
    doc = stored(mock_mongo)
    assert doc["subject"] == ""
    assert doc["has_attachments"] is True
    assert doc["attachments"][0]["filename"] == "scan.pdf"
    assert doc["attachments"][0]["content"] == b"%PDF-1.4"


def test_truly_empty_mail_is_still_rejected(test_account, mock_mongo):
    assert deliver(raw(BASIC, b"")) == "554 5.6.0 Empty message rejected"
    assert mock_mongo.messages.count_documents({}) == 0


def test_html_only_mail(test_account, mock_mongo):
    deliver(raw(BASIC + ["Subject: html", "Content-Type: text/html; charset=utf-8"], b"<p>Hello</p>"))
    doc = stored(mock_mongo)
    assert doc["html"] == "<p>Hello</p>"
    assert doc["text"] == ""


def test_alternative_keeps_first_plain_and_html(test_account, mock_mongo):
    deliver(multipart(BASIC + ["Subject: alt"], [
        (["Content-Type: text/plain; charset=utf-8"], b"plain version"),
        (["Content-Type: text/html; charset=utf-8"], b"<b>html version</b>"),
    ], subtype="alternative"))
    doc = stored(mock_mongo)
    assert doc["text"] == "plain version"
    assert doc["html"] == "<b>html version</b>"
    assert doc["attachments"] == []
    assert doc["intro"] == "plain version"


def test_related_inline_image_is_kept(test_account, mock_mongo):
    deliver(multipart(BASIC + ["Subject: newsletter"], [
        (["Content-Type: text/html"], b'<img src="cid:logo">'),
        (["Content-Type: image/png", "Content-ID: <logo>", "Content-Transfer-Encoding: base64"], b"iVBORw0KGgo="),
    ], subtype="related"))
    doc = stored(mock_mongo)
    assert doc["html"] == '<img src="cid:logo">'
    assert doc["attachments"][0]["content_type"] == "image/png"


def test_calendar_invite_is_kept_as_ics(test_account, mock_mongo):
    deliver(multipart(BASIC + ["Subject: Meeting"], [
        (["Content-Type: text/plain"], b"Join us"),
        (["Content-Type: text/calendar; method=REQUEST"], b"BEGIN:VCALENDAR\r\nEND:VCALENDAR"),
    ], subtype="alternative"))
    doc = stored(mock_mongo)
    assert doc["text"] == "Join us"
    [invite] = doc["attachments"]
    assert invite["filename"] == "attachment-1.ics"
    assert invite["content_type"] == "text/calendar"
    assert invite["content"].startswith(b"BEGIN:VCALENDAR")


def test_forwarded_mail_is_stored_whole_and_does_not_replace_body(test_account, mock_mongo):
    inner = raw(["From: original@example.org", "Subject: inner subject", "Content-Type: text/html"], b"<b>INNER</b>")
    deliver(multipart(BASIC + ["Subject: Fwd"], [
        (["Content-Type: text/plain"], b"see attached"),
        (["Content-Type: message/rfc822", "Content-Disposition: attachment"], inner),
    ]))
    doc = stored(mock_mongo)
    assert doc["text"] == "see attached"
    assert doc["html"] == ""
    [eml] = doc["attachments"]
    assert eml["filename"] == "attachment-1.eml"
    assert eml["content_type"] == "message/rfc822"
    reparsed = message_from_bytes(eml["content"], policy=policy.default)
    assert reparsed["Subject"] == "inner subject"
    assert reparsed.get_content().strip() == "<b>INNER</b>"


def test_empty_wrapper_shows_attached_mail_body(test_account, mock_mongo):
    inner = multipart(["From: original@example.org", "Subject: inner"], [
        (["Content-Type: text/plain; charset=utf-8"], "原文".encode()),
        (["Content-Type: text/html; charset=utf-8"], b"<p>original</p>"),
    ], subtype="alternative")
    deliver(multipart(BASIC + ["Subject: Fwd: inner"], [(["Content-Type: message/rfc822"], inner)]))
    doc = stored(mock_mongo)
    assert doc["text"] == "原文"
    assert doc["html"] == "<p>original</p>"
    assert [a["content_type"] for a in doc["attachments"]] == ["message/rfc822"]


def test_bounce_shows_explanation_and_keeps_report_parts(test_account, mock_mongo):
    original = raw(["From: testuser@test.local", "Subject: my original", "Content-Type: text/html"], b"<p>original</p>")
    deliver(multipart(["From: MAILER-DAEMON@mx.example.org", f"To: {RCPT}", "Subject: Undelivered Mail"], [
        (["Content-Type: text/plain"], b"Your message could not be delivered."),
        (["Content-Type: message/delivery-status"],
         b"Reporting-MTA: dns; mx.example.org\r\n\r\nFinal-Recipient: rfc822; nobody@example.org\r\nStatus: 5.1.1\r\n"),
        (["Content-Type: message/rfc822"], original),
    ], subtype='report; report-type=delivery-status'))
    doc = stored(mock_mongo)
    assert doc["text"] == "Your message could not be delivered."
    assert doc["html"] == ""
    names = [a["filename"] for a in doc["attachments"]]
    assert names == ["attachment-1.txt", "attachment-2.eml"]
    assert b"Status: 5.1.1" in doc["attachments"][0]["content"]
    assert b"my original" in doc["attachments"][1]["content"]


def test_named_text_attachment_is_not_taken_as_body(test_account, mock_mongo):
    deliver(multipart(BASIC + ["Subject: log"], [
        (["Content-Type: text/plain"], b"see log"),
        (["Content-Type: text/plain", "Content-Disposition: attachment; filename=app.log"], b"ERROR 1"),
    ]))
    doc = stored(mock_mongo)
    assert doc["text"] == "see log"
    assert [(a["filename"], a["content"]) for a in doc["attachments"]] == [("app.log", b"ERROR 1")]


def test_rfc2231_filename_decodes(test_account, mock_mongo):
    deliver(multipart(BASIC + ["Subject: cn file"], [
        (["Content-Type: text/plain"], b"x"),
        (["Content-Type: application/pdf",
          "Content-Disposition: attachment; filename*=UTF-8''%E5%90%88%E5%90%8C.pdf"], b"pdf"),
    ]))
    assert stored(mock_mongo)["attachments"][0]["filename"] == "合同.pdf"


def test_intro_is_whitespace_collapsed_and_capped(test_account, mock_mongo):
    deliver(raw(BASIC + ["Subject: long"], b"a  \r\n\r\n b " + b"x" * 500))
    intro = stored(mock_mongo)["intro"]
    assert intro.startswith("a b x")
    assert len(intro) == 200
