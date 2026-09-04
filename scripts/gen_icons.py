#!/usr/bin/env python3
"""从 RabbitReminder 品牌原图导出 PWA 所需尺寸（macOS sips）。"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'scripts/assets/rabbitreminder-source.png'

if __name__ == '__main__':
    for size, name in [(512, 'rabbit-wallet-512.png'), (192, 'rabbit-wallet-192.png'),
                       (180, 'rabbit-wallet-apple.png')]:
        subprocess.run(['sips', '-z', str(size), str(size), str(SOURCE),
                        '--out', str(ROOT / 'public' / name)], check=True)
