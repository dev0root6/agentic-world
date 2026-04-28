import re

FILE = "index.html"

def patch_file():
    content = open(FILE, "r", encoding="utf-8").read()

    # ── 1. Locate TILE section (robust)
    tile_match = re.search(r'//\s*TILE\s+IDs', content)
    if not tile_match:
        raise Exception("TILE IDs section not found")

    start = tile_match.start()

    # ── 2. Locate drawMap() (end boundary)
    draw_match = re.search(r'function\s+drawMap\s*\(', content[start:])
    if not draw_match:
        raise Exception("drawMap() not found")

    end = start + draw_match.start()

    print(f"[+] Found TILE section at: {start}")
    print(f"[+] Found drawMap() at: {end}")

    # ── 3. Extract old block (for debugging / diff)
    old_block = content[start:end]

    print(f"[+] Old block size: {len(old_block)} chars")

    # ── 4. New block (your upgraded system)
    new_block = """// TILE IDs
const T = {
  WALL:0, OFFICE:1, SCIFI:2, VILLAGE:3, OUTDOOR:4,
  DESK:5, MACHINE:6, TREE:8, WATER:9,
  ROAD:10, GRASS:11, PATH:12,
  V_FLOOR:14, V_WALL_H:15, V_WALL_V:16, V_ROOF:17,
  V_DOOR:18, V_WINDOW:19
};

let worldMap = [];
let decoMap = [];

function buildMap() {
  worldMap = Array.from({length:MAP_H}, () => new Array(MAP_W).fill(T.WALL));
  decoMap  = Array.from({length:MAP_H}, () => new Array(MAP_W).fill(0));

  const fill = (x1,y1,x2,y2,t) => {
    for (let y=y1;y<=y2;y++)
      for (let x=x1;x<=x2;x++)
        worldMap[y][x]=t;
  };

  fill(1,1,37,27,T.OFFICE);
  fill(42,1,78,27,T.SCIFI);
  fill(1,32,37,58,T.VILLAGE);
  fill(42,32,78,58,T.OUTDOOR);

  for (let y=28;y<=31;y++)
    for (let x=0;x<MAP_W;x++)
      worldMap[y][x]=T.ROAD;

  for (let y=0;y<MAP_H;y++)
    for (let x=38;x<=41;x++)
      worldMap[y][x]=T.ROAD;
}
"""

    # ── 5. Replace safely
    updated = content[:start] + new_block + content[end:]

    # ── 6. Backup original
    open(FILE + ".bak", "w", encoding="utf-8").write(content)

    # ── 7. Write patched file
    open(FILE, "w", encoding="utf-8").write(updated)

    print("[+] Patch applied successfully")
    print("[+] Backup saved as index.html.bak")


if __name__ == "__main__":
    patch_file()
