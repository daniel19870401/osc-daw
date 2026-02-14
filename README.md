# OSCDAW

Electron + React 的 OSC/Audio/MIDI/DMX 時間軸控制 DAW。

## 目前封裝版本（v1.0.0）

位於 `release/`：

- `OSCDAW-win-x64.exe`（Windows Intel x64）
- `OSCDAW-win-arm64.exe`（Windows ARM64）
- `OSCDAW-mac-arm64.zip`（macOS Apple Silicon）

## 開發

```bash
npm install
npm run dev
```

- Vite dev server 使用 `5170`
- OSC 的送出/接收/控制 port 請不要設為 `5170`

## 重新封裝

```bash
npm run build
npx electron-builder --win portable --x64 --config.win.signAndEditExecutable=false --config.artifactName='${productName}-${os}-${arch}.${ext}'
npx electron-builder --win portable --arm64 --config.win.signAndEditExecutable=false --config.artifactName='${productName}-${os}-${arch}.${ext}'
npx electron-builder --mac zip --arm64 --config.mac.identity=null --config.artifactName='${productName}-${os}-${arch}.${ext}'
```

## Help（快捷鍵 / 控制）

### Keyboard

- `Space`：Play / Pause
- `C`：播放時在播放軸新增 Cue
- `,`：跳上一個 Cue
- `.`：跳下一個 Cue
- `=`：在播放軸新增 Cue
- `-`：刪除播放軸附近的 Cue
- `Backspace/Delete`：刪除選取 Node 或 Track
- `Cmd/Ctrl + O`：新增 OSC Track
- `Cmd/Ctrl + A`：新增 Audio Track
- `Cmd/Ctrl + M`：新增 MIDI Track
- `Cmd/Ctrl + D`：新增 DMX Track
- `Cmd/Ctrl + C`：複製選取 Track 或 Node
- `Cmd/Ctrl + V`：貼上 Track，或在播放軸貼上 Node
- `Cmd/Ctrl + Z`：Undo
- `Cmd/Ctrl + Shift + Z`：Redo
- `Cmd/Ctrl + Y`：Redo（替代）
- `Esc`：關閉 Help

### Mouse

- 雙擊 Timeline：新增 Cue
- 拖拉 Cue：移動 Cue 時間
- 右鍵 Cue：編輯 / 刪除
- 雙擊 Composition：改名
- 拖拉 Composition：改順序
- `Alt/Option + 點擊 Track 的 +`：開啟 Multi Add（一次新增多軌）
- 雙擊 Node：編輯數值
- 拖拉 Node：改時間與數值
- `Alt/Option + 拖拉 Node`：吸附到最近 Cue
- 右鍵 Node：切換曲線模式
- 點擊色塊：套用 Track 顏色
- `Shift + 點 Track`：範圍選取
- `Ctrl/Cmd + 點 Track`：間隔多選
- `Shift + Alt/Option + 滾輪`：Zoom T
- `Shift + Ctrl + 滾輪`：Zoom H

### OSC Remote Control

先在 `Settings > OSC > OSC Control Port` 設定監聽 port。

Composition index 為 1-based（依左側 Composition 清單順序）。

- `/OSCDAW/Composition/5/select`：切換到 Composition #5
- `/OSCDAW/Composition/1/rec 1`：切到 #1 並開啟 REC
- `/OSCDAW/Composition/1/rec 0`：切到 #1 並關閉 REC
- `/OSCDAW/Composition/1/play 1`：切到 #1 並播放
- `/OSCDAW/Composition/1/play 0`：切到 #1 並停止播放
- `/OSCDAW/Composition/1/stop 1`：切到 #1 並停止＋定位到 `00:00:00.00`
- `/OSCDAW/Composition/1/cue 10`：切到 #1 並跳到 Cue #10
- `/OSCDAW/Composition/1/cue/10`：Cue 跳轉替代格式

Legacy（仍支援）：

- `/OSCDAW/rec`
- `/OSCDAW/play`
- `/OSCDAW/stop`
- `/OSCDAW/cue`

## Brand

- NL Interactive
- Copyright © NL Interactive

## Donate

如果這個專案對你有幫助，歡迎支持：

![OSCDAW Donate QRCode](docs/assets/oscdaw-donate-qrcode.png)
