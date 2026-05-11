# Tool quản lý project Codex/dev server

## Mục tiêu

Thiết kế một app desktop nhỏ trên Windows để quản lý các project trong Codex sidebar và các thư mục code thật phía sau. Tool cho phép bật/tắt từng project, quản lý nhiều process trong một project, xem trạng thái chạy, log và mở link giao diện local như `http://localhost:5173`.

## Phạm vi V1

- App desktop Windows dùng Electron.
- Danh sách project lấy từ cả hai nguồn:
  - Tự scan project/workspace.
  - Người dùng thêm folder thủ công.
- Mỗi project trỏ tới một thư mục code thật.
- Khi thêm project, app tự phát hiện command chạy làm gợi ý.
- Người dùng sửa được name, path, command, cwd, env, port và URL.
- Một project có thể có nhiều process, ví dụ frontend, backend, worker.
- Start project: chạy tất cả process đang enabled.
- Stop project: tắt toàn bộ process tree do app đã khởi động.
- Log chỉ xem trong app ở V1, chưa cần lưu file.
- URL/port được xác định theo nhiều nguồn: config thủ công, parse log, framework default, detect port từ process.

## Layout đề xuất

```text
Sidebar project
- Project list
- Search/filter
- Add folder
- Auto scan
- Running/stopped indicator

Main dashboard
- Start / Stop / Restart project
- Start / Stop từng process
- Process list
- CPU/RAM
- Uptime
- Port/URL
- Last log
- Last error

Right panel
- Link giao diện localhost
- Nút Open
- Preview web trong app hoặc mở bằng browser mặc định
```

## Dữ liệu cấu hình

Lưu cấu hình trong `projects.json` hoặc trong thư mục `userData` của Electron.

```json
{
  "projects": [
    {
      "id": "video-tool",
      "name": "video tool",
      "path": "C:\\Users\\Admin'\\Documents\\New project 3",
      "autoDetected": true,
      "processes": [
        {
          "id": "frontend",
          "name": "frontend",
          "cwd": "C:\\Users\\Admin'\\Documents\\New project 3",
          "command": "npm",
          "args": ["run", "dev"],
          "url": "http://localhost:5173",
          "port": 5173,
          "enabled": true
        },
        {
          "id": "backend",
          "name": "backend",
          "cwd": "C:\\Users\\Admin'\\Documents\\New project 3\\server",
          "command": "python",
          "args": ["app.py"],
          "url": "http://localhost:8000",
          "port": 8000,
          "enabled": true
        }
      ]
    }
  ]
}
```

## Auto detect command

Khi người dùng add folder hoặc auto scan, app tạo gợi ý dựa trên file trong thư mục.

```text
package.json
- scripts.dev -> npm run dev / pnpm dev / yarn dev
- scripts.start -> npm start / pnpm start / yarn start
- pnpm-lock.yaml -> ưu tiên pnpm
- yarn.lock -> ưu tiên yarn

vite.config.*
- gợi ý URL: http://localhost:5173

next.config.*
- gợi ý URL: http://localhost:3000

docker-compose.yml / compose.yml
- gợi ý command: docker compose up

pyproject.toml / requirements.txt
- nhận diện Python project
- yêu cầu người dùng xác nhận command vì Python có nhiều kiểu chạy

.env / .env.local
- đọc PORT nếu có
```

Auto detect chỉ là gợi ý. Người dùng phải sửa được mọi trường quan trọng.

## Start/Stop process

Electron main process chịu trách nhiệm chạy command và quản lý vòng đời process.

Luồng start:

```text
1. Người dùng bấm Start project.
2. App lấy danh sách process enabled.
3. Spawn từng process với cwd/env riêng.
4. Capture stdout/stderr.
5. Cập nhật trạng thái Running, PID, uptime, log.
6. Parse log để tìm URL/port nếu chưa có config.
```

Luồng stop:

```text
1. Người dùng bấm Stop project.
2. App lấy PID của các process do app tạo.
3. Kill toàn bộ process tree trên Windows.
4. Cập nhật trạng thái Stopped.
```

Trên Windows có thể dùng:

```powershell
taskkill /PID <pid> /T /F
```

Nguyên tắc an toàn V1: chỉ tắt process do app khởi động. Không tự kill process ngoài nếu chỉ phát hiện nó đang chiếm port.

## Trạng thái dashboard

Mỗi project hiển thị:

- `Running` / `Stopped` / `Partial` / `Error`
- Số process đang chạy.
- URL chính.
- Port chính.
- CPU tổng.
- RAM tổng.
- Uptime.
- Last log.
- Last error.

Mỗi process hiển thị:

- Name.
- Command.
- PID.
- Running/stopped.
- CPU/RAM.
- Uptime.
- Port/URL.
- Log realtime.
- Error gần nhất.

## Log

V1 chỉ giữ log trong app bằng ring buffer.

Đề xuất:

- 2.000 dòng gần nhất mỗi process.
- Tách stdout và stderr.
- Last error lấy từ stderr hoặc dòng có keyword: `error`, `failed`, `exception`, `traceback`.
- Sau này thêm export log nếu cần.

## URL/Port detection

Thứ tự xác định URL:

```text
1. URL người dùng cấu hình thủ công.
2. Parse stdout/stderr, ví dụ:
   - Local: http://localhost:5173
   - ready on http://localhost:3000
   - Listening on port 8000
3. Đọc PORT trong .env.
4. Framework default:
   - Vite: 5173
   - Next: 3000
   - Common backend: 8000
5. Detect port từ process tree nếu khả thi.
```

Nếu chưa xác định được, hiển thị `No URL detected`.

## Stack kỹ thuật

```text
Electron main
- đọc/ghi config
- scan folder
- auto detect commands
- spawn/kill process
- collect log
- đo CPU/RAM
- IPC API

Renderer
- React + Vite
- project list
- dashboard
- process editor
- log viewer
- right-side URL panel

Storage
- JSON config trong Electron userData
```

## Chưa làm ở V1

- Điều khiển từ điện thoại.
- Telegram bot.
- Cloud sync.
- User account.
- Kill process ngoài app theo port.
- Lưu log dài hạn.
- Auto import hoàn hảo từ Codex sidebar nếu không có API chính thức.

## Quyết định đã chốt

- Dùng Electron.
- Project list dùng cả auto scan và thêm thủ công.
- Có thư mục code thật cho mỗi project.
- Auto detect command là gợi ý, người dùng sửa được.
- Stop nghĩa là tắt dev server/process của project.
- Một project có thể có nhiều process.
- Log xem trong app.
- URL/port dùng config trước, sau đó parse log và detect.
- Chưa cần điều khiển từ điện thoại ở giai đoạn này.
