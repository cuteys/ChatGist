# 构建阶段
FROM golang:alpine AS builder

WORKDIR /build

ENV GOPROXY=https://goproxy.cn,https://proxy.golang.org,direct
ENV CGO_ENABLED=0

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# 编译去除调试信息并修剪源码路径以压缩镜像体积
RUN go build -ldflags="-s -w" -trimpath -o /build/chatgist ./cmd/bot

# 运行阶段
FROM alpine:latest

RUN apk --no-cache add ca-certificates tzdata

ENV TZ=Asia/Shanghai
ENV DB_PATH=/app/data/sqlite.db
ENV MODE=polling

WORKDIR /app

COPY --from=builder /build/chatgist /app/chatgist

VOLUME ["/app/data"]

ENTRYPOINT ["/app/chatgist"]
