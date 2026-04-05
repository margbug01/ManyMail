import smtplib
from email.mime.text import MIMEText

msg = MIMEText('Your verification code is: 123456. This is a test email.')
msg['Subject'] = 'Test - Your code is 123456'
msg['From'] = 'test@example.com'
msg['To'] = 'test001@damnv.lol'

with smtplib.SMTP('localhost', 25) as s:
    s.send_message(msg)
    print('Email sent successfully!')
