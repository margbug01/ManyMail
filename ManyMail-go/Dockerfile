# The binary is built outside the image (pure Go, no cgo):
#   CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o manymail .
#   docker build -t manymail-go .
# Inside a container, non-root processes may bind port 25 (Docker sets
# net.ipv4.ip_unprivileged_port_start=0), so SMTP_PORT=25 works as user 10001.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates \
 && adduser -D -H -u 10001 manymail \
 && mkdir /data && chown manymail /data
COPY manymail /usr/local/bin/manymail
USER manymail
ENV DB_PATH=/data/manymail.db
VOLUME /data
EXPOSE 25 5000 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:${API_PORT:-8080}/health || exit 1
ENTRYPOINT ["/usr/local/bin/manymail"]
