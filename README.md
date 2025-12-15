# 3Blast

A simple 3D city destruction game made with Three.js.

## Run

You must run from a local web server (ES modules won’t load from `file://`).

### Option A: Python

```bash
cd c:\dev\3blast
python -m http.server 5173
```

Open:

- http://localhost:5173/

### Option B: Node

```bash
cd c:\dev\3blast
npx serve
```

## Controls

- Mouse: look (click to lock)
- WASD: move
- Space / Shift: up / down
- Left click: fire
- 1/2/3: switch weapons (Cannon / Rocket / Laser)
- R: reset city
- Esc: unlock mouse
