FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py .
RUN useradd --system --no-create-home router
USER router

CMD ["python", "app.py"]
