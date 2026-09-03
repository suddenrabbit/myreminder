#!/usr/bin/env python3
"""生成 myreminder PWA 图标（icon-192 / icon-512 / apple-touch-icon 180）。"""
from PIL import Image, ImageDraw

BRAND = (59, 107, 250, 255)  # #3b6bfa


def rounded(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size, out):
    scale = size / 512.0
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def S(v):
        return int(v * scale)

    # 圆角渐变底
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(53 + (91 - 53) * t)
        g = int(124 + (107 - 124) * t)
        b = int(250 + (250 - 250) * t)
        gd.line([(0, y), (size, y)], fill=(r, g, b, 255))
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=S(118), fill=255)
    img.paste(grad, (0, 0), mask)

    # 顶部高光
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([S(118), S(108), size - S(118), S(150)], radius=S(18), fill=(255, 255, 255, 46))

    # 中央白卡（卡片本体）
    card_left, card_top = S(96), S(150)
    card_w, card_h = S(320), S(212)
    rounded(d, [card_left, card_top, card_left + card_w, card_top + card_h], S(28), (255, 255, 255, 255))

    # 卡面芯片
    chip_x, chip_y = S(128), S(186)
    chip_w, chip_h = S(56), S(44)
    rounded(d, [chip_x, chip_y, chip_x + chip_w, chip_y + chip_h], S(10), (236, 201, 116, 255))
    d.rectangle([S(140), S(196), chip_x + chip_w - S(12), S(198)], fill=(190, 150, 70, 255))
    d.rectangle([S(148), S(196), S(150), chip_y + chip_h - S(12)], fill=(190, 150, 70, 255))

    # 卡片上的文字占位横线
    line_x = S(212)
    line_color = (216, 221, 236, 255)
    d.rounded_rectangle([line_x, S(196), size - S(150), S(206)], radius=S(5), fill=line_color)
    d.rounded_rectangle([line_x, S(214), size - S(168), S(224)], radius=S(5), fill=line_color)

    # 卡片下方小字
    d.rounded_rectangle([S(128), S(276), S(196), S(286)], radius=S(5), fill=line_color)
    d.rounded_rectangle([S(128), S(294), S(258), S(304)], radius=S(5), fill=line_color)
    d.rounded_rectangle([S(128), S(312), S(172), S(320)], radius=S(4), fill=(236, 239, 249, 255))

    # 右上角提醒小红点
    cx, cy = size - S(150), S(150)
    r = S(44)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(240, 90, 80, 255))
    d.ellipse([cx - r + S(4), cy - r + S(4), cx + r - S(4), cy + r - S(4)], outline=(255, 255, 255, 200), width=S(5))
    # 白底铃铛简化：小圆点
    d.ellipse([cx - S(10), cy - S(10), cx + S(10), cy + S(10)], fill=(255, 255, 255, 255))

    img.save(out, "PNG")


if __name__ == "__main__":
    import os

    base = os.path.dirname(os.path.abspath(__file__))
    public = os.path.join(base, "..", "public")
    make_icon(512, os.path.join(public, "icon-512.png"))
    make_icon(192, os.path.join(public, "icon-192.png"))
    make_icon(180, os.path.join(public, "apple-touch-icon.png"))
    print("icons written to public/")
