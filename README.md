# OSConductor

<p align="left">
  <img src="docs/assets/osconductor-ui.png" alt="OSConductor UI" width="900" />
</p>

本程式全部由 AI vibe coding 產出。

OSC/Audio/MIDI/DMX 時間軸控制軟體。

## 所有功能

- 時間軸播放、MTC/LTC 同步、多曲目編排
- OSC 傳送數值、OSC Array、OSC Flag、OSC Color
- DMX Color、DMX single value
- Audio 排列播放
- MIDI CC、MIDI Note

## 目前封裝版本（v1.2.0）

位於 `release/`：

- `OSConductor-1.2.0-win-x64.exe`（Windows Intel x64）
- `OSConductor-1.2.0-win-arm64.exe`（Windows ARM64）
- `OSConductor-1.2.0-arm64-mac.zip`（macOS Apple Silicon）

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
npx electron-builder --win portable --x64 --config.win.signAndEditExecutable=false --publish never
npx electron-builder --win portable --arm64 --config.win.signAndEditExecutable=false --publish never
npx electron-builder --mac zip --arm64 --config.mac.identity=null --publish never
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
- `Cmd/Ctrl + Shift + D`：新增 DMX Color Track
- `Cmd/Ctrl + C`：複製選取 Track 或 Node
- `Cmd/Ctrl + V`：貼上 Track，或在播放軸貼上 Node
- `Cmd/Ctrl + Z`：Undo
- `Cmd/Ctrl + Shift + Z`：Redo
- `Cmd/Ctrl + Y`：Redo（替代）
- `Cmd/Ctrl + =`：Timeline Zoom In
- `Cmd/Ctrl + -`：Timeline Zoom Out
- `Enter（Audio Channel Map）`：儲存目前 mapping 並跳下一個 Audio Track
- `↓（Audio Channel Map）`：儲存目前 mapping 並跳下一個 Audio Track
- `Top Bar: Comps`：顯示 / 隱藏 Composition 面板
- `Top Bar: Inspector`：顯示 / 隱藏 Inspector 面板
- `Esc`：關閉 Help

### Mouse

- 雙擊 Timeline：新增 Cue
- 拖拉 Cue：移動 Cue 時間
- 右鍵 Cue：編輯 / 刪除
- 雙擊 Composition：改名
- 拖拉 Composition：改順序
- `Alt/Option + 點擊 Track 的 +`：開啟 Multi Add（一次新增多軌）
- 雙擊 Node：編輯數值 / 顏色（OSC Flag 會編輯 `Time + OSC Address + OSC Value`）
- 拖拉 Node：改時間與數值
- `Alt/Option + 拖拉 Node`：吸附到最近 Cue
- 右鍵 Node：切換曲線模式
- 點擊色塊：套用 Track 顏色（可對多選軌道）
- `Shift + 點 Track`：範圍選取
- `Ctrl/Cmd + 點 Track`：間隔多選
- `Shift + Alt/Option + 滾輪`：Zoom T
- `Shift + Ctrl + 滾輪`：Zoom H

### Project / Audio Notes

- 新專案預設長度：`01:00:00.00`
- 載入 Audio Clip 不會自動改變 Project Length
- Audio Clip 在時間軸極小縮放時，Clip 開頭仍會與時間軸對齊
- 新增 Track 類型：`OSC Flag`（播放軸經過節點時觸發對應 OSC Address/Value）

### OSC Remote Control

先在 `Settings > OSC > OSC Control Port` 設定監聽 port。

Composition index 為 1-based（依左側 Composition 清單順序）。

- `/OSConductor/Composition/5/select`：切換到 Composition #5
- `/OSConductor/Composition/1/rec 1`：切到 #1 並開啟 REC
- `/OSConductor/Composition/1/rec 0`：切到 #1 並關閉 REC
- `/OSConductor/Composition/1/play 1`：切到 #1 並播放
- `/OSConductor/Composition/1/play 0`：切到 #1 並停止播放
- `/OSConductor/Composition/1/stop 1`：切到 #1 並停止＋定位到 `00:00:00.00`
- `/OSConductor/Composition/1/loop 1`：切到 #1 並開啟 Loop
- `/OSConductor/Composition/1/loop 0`：切到 #1 並關閉 Loop
- `/OSConductor/Composition/1/cue 10`：切到 #1 並跳到 Cue #10
- `/OSConductor/Composition/1/cue/10`：Cue 跳轉替代格式

## Brand

<p align="left">
  <img src="docs/assets/nl-interactive-logo.png" alt="NL interactive logo" width="140" />
</p>

- NL Interactive
- Copyright © NL Interactive

## Donate

如果這個專案對你有幫助，歡迎小額捐款支持：

![OSConductor Donate QRCode](docs/assets/osconductor-donate-qrcode.png)
