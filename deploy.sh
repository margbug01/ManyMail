#!/bin/bash
# 邮件服务器部署脚本 - 在 Lightsail 服务器上运行
set -e

echo "=============================="
echo "  Mail Server Deploy Script"
echo "=============================="

# 1. 安装 Docker (如果未安装)
if ! command -v docker &> /dev/null; then
    echo "[1/4] Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    echo "Docker installed. You may need to re-login for group changes."
else
    echo "[1/4] Docker already installed."
fi

# 2. 安装 Docker Compose plugin (如果未安装)
if ! docker compose version &> /dev/null; then
    echo "[2/4] Installing Docker Compose plugin..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-compose-plugin
else
    echo "[2/4] Docker Compose already installed."
fi

# 3. 确保 Docker 服务运行
echo "[3/4] Starting Docker service..."
sudo systemctl enable docker
sudo systemctl start docker

# 4. 启动服务
echo "[4/4] Starting mail server..."
cd /opt/mail-server
sudo docker compose down 2>/dev/null || true
sudo docker compose up -d --build

echo ""
echo "=============================="
echo "  Deploy Complete!"
echo "=============================="
echo ""
echo "SMTP: port 25 (receiving mail)"
echo "API:  port 8080 (REST API)"
echo ""
echo "Health check:"
echo "  curl http://localhost:8080/health"
echo ""
echo "API docs:"
echo "  http://<your-ip>:8080/api-docs"
echo ""
echo "View logs:"
echo "  sudo docker compose logs -f"
