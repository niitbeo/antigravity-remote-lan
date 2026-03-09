# Antigravity Remote Extension

Tien ich dieu khien Antigravity tu xa qua mang LAN.

Tac gia: Nguyen Le Truong

## Tinh nang

- Chay relay server noi bo (`HTTP + WebSocket`) trong extension host
- Dashboard web tren mobile de:
  - Gui prompt
  - Accept/reject agent step
  - Accept/reject terminal command
  - Chuyen session dang hoat dong
- Giam sat session realtime qua `antigravity-sdk`
- Pair bang URL token + lenh hien thi QR
- Chi bao trang thai tren status bar (`AG Remote: on/off/error`)

## Lenh

- `Antigravity Remote: Start Relay`
- `Antigravity Remote: Stop Relay`
- `Antigravity Remote: Show Connect Info`
- `Antigravity Remote: Show Pairing QR`
- `Antigravity Remote: Reset Pairing Token`

## Cai dat

- `antigravityRemote.host` (mac dinh `0.0.0.0`)
- `antigravityRemote.port` (mac dinh `4317`)
- `antigravityRemote.autoStart` (mac dinh `true`)

## Phat trien

```bash
npm install
npm run build
```

Chay extension trong Extension Development Host:

1. Mo thu muc nay bang Antigravity/VS Code
2. Nhan `F5` (dung `.vscode/launch.json`)
3. Trong host window, chay `Antigravity Remote: Start Relay`
4. Chay `Antigravity Remote: Show Pairing QR` hoac `Show Connect Info`

## Dong goi VSIX

```bash
npm run package
```

Sau do cai file `.vsix` duoc tao vao Antigravity/VS Code.

## Tai VSIX

- Ban moi nhat: `antigravity-remote-mvp-0.0.34.vsix`
- Link tai truc tiep:
  `https://github.com/niitbeo/antigravity-remote-lan/raw/main/antigravity-remote-mvp-0.0.34.vsix`

## Bao mat

- Relay dinh huong LAN va duoc gate bang token
- Co the reset token bat ky luc nao bang lenh `Reset Pairing Token`
- Chi dung trong mang Wi-Fi tin cay

## Gioi han hien tai

- Chua co push notification
- Chua co queued approval inbox UI
- Chua co audit history luu lau dai
