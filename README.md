# Antigravity Remote Extension

Tiện ích điều khiển Antigravity từ xa qua mạng LAN.

Tác giả: Nguyễn Lê Trường

## Tính năng

- Chạy relay server nội bộ (`HTTP + WebSocket`) trong extension host
- Dashboard web tren mobile de:
  - Gửi prompt
  - Accept/reject agent step
  - Accept/reject terminal command
  - Chuyển session đang hoạt động
- Giám sát session realtime qua `antigravity-sdk`
- Pair bằng URL token + lệnh hiển thị QR
- Chỉ báo trạng thái trên status bar (`AG Remote: on/off/error`)

## Lệnh

- `Antigravity Remote: Start Relay`
- `Antigravity Remote: Stop Relay`
- `Antigravity Remote: Show Connect Info`
- `Antigravity Remote: Show Pairing QR`
- `Antigravity Remote: Reset Pairing Token`

## Cài đặt

- `antigravityRemote.host` (mặc định `0.0.0.0`)
- `antigravityRemote.port` (mặc định `4317`)
- `antigravityRemote.autoStart` (mặc định `true`)

## Phát triển

```bash
npm install
npm run build
```

Chạy extension trong Extension Development Host:

1. Mở thư mục này bằng Antigravity/VS Code
2. Nhấn `F5` (dùng `.vscode/launch.json`)
3. Trong host window, chạy `Antigravity Remote: Start Relay`
4. Chạy `Antigravity Remote: Show Pairing QR` hoặc `Show Connect Info`

## Đóng gói VSIX

```bash
npm run package
```

Sau đó cài file `.vsix` được tạo vào Antigravity/VS Code.

## Tải VSIX

- Bản mới nhất: `antigravity-remote-mvp-0.0.34.vsix`
- Link tải trực tiếp:
  `https://github.com/niitbeo/antigravity-remote-lan/raw/main/antigravity-remote-mvp-0.0.34.vsix`

## Bảo mật

- Relay định hướng LAN và được gate bằng token
- Có thể reset token bất kỳ lúc nào bằng lệnh `Reset Pairing Token`
- Chỉ dùng trong mạng Wi-Fi tin cậy

## Giới hạn hiện tại

- Chưa có push notification
- Chưa có queued approval inbox UI
- Chưa có audit history lưu lâu dài
