"""从外部通过 MX 解析发送邮件到自建邮箱服务器"""
import smtplib
from email.mime.text import MIMEText

# 直接连接自建服务器的 SMTP 端口
SMTP_HOST = "161.33.195.3"
SMTP_PORT = 25

msg = MIMEText("Your OpenAI verification code is: 789012. Do not share this code.")
msg["Subject"] = "Your verification code is 789012"
msg["From"] = "noreply@openai.com"
msg["To"] = "testmail@damnv.lol"

try:
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
        s.send_message(msg)
        print("Email sent successfully to testmail@damnv.lol!")
except Exception as e:
    print(f"Failed: {e}")
