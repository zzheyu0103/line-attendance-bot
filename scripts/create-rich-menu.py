from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "rich-menu.png"
OUT.parent.mkdir(parents=True, exist_ok=True)

width, height = 2500, 843
image = Image.new("RGB", (width, height), "#F4F8F6")
draw = ImageDraw.Draw(image)
font_path = Path("C:/Windows/Fonts/msjhbd.ttc")
font = ImageFont.truetype(str(font_path), 94)
small = ImageFont.truetype(str(font_path), 35)

buttons = [
    ("上班", "開始今天的工作", "#087F5B", "#FFFFFF"),
    ("下班", "完成今天的工時", "#0F766E", "#FFFFFF"),
    ("今日", "查看打卡紀錄", "#E7F6EF", "#075E45"),
    ("班表", "未來七天排班", "#DDF0EA", "#075E45"),
]

cell = width // 4
for index, (title, subtitle, background, foreground) in enumerate(buttons):
    left = index * cell
    right = width if index == 3 else (index + 1) * cell
    draw.rounded_rectangle((left + 18, 18, right - 18, height - 18), radius=46, fill=background)
    title_box = draw.textbbox((0, 0), title, font=font)
    title_width = title_box[2] - title_box[0]
    draw.text(((left + right - title_width) / 2, 270), title, font=font, fill=foreground)
    sub_box = draw.textbbox((0, 0), subtitle, font=small)
    sub_width = sub_box[2] - sub_box[0]
    draw.text(((left + right - sub_width) / 2, 410), subtitle, font=small, fill=foreground)
    dot = "●"
    dot_box = draw.textbbox((0, 0), dot, font=small)
    draw.text(((left + right - (dot_box[2] - dot_box[0])) / 2, 550), dot, font=small, fill=foreground)

image.save(OUT, "PNG", optimize=True)
print(OUT)
