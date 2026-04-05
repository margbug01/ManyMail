FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# SMTP=25, API=8080
EXPOSE 25 8080

CMD ["python", "app.py"]
