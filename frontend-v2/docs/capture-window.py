"""Capture the ITax window by handle, using PrintWindow with the
PW_RENDERFULLCONTENT flag so WebView2 content is included.

A plain BitBlt of a composited/DWM window returns black for the webview
surface; PW_RENDERFULLCONTENT (0x2) is the flag that fixes exactly that.
"""
import ctypes
import ctypes.wintypes as w
import sys
import time

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
user32.SetProcessDPIAware()

TITLE_HINT = "Income Tax"
PW_RENDERFULLCONTENT = 0x00000002


def find_window():
    found = []

    @ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if TITLE_HINT.lower() in buf.value.lower():
            found.append((hwnd, buf.value))
        return True

    user32.EnumWindows(cb, 0)
    return found


def capture(hwnd, path):
    rect = w.RECT()
    # Client area only: excludes the shadow border that DWM reports.
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width <= 0 or height <= 0:
        return None, (width, height)

    hdc = user32.GetWindowDC(hwnd)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, width, height)
    gdi32.SelectObject(mem, bmp)

    ok = user32.PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", w.DWORD), ("biWidth", w.LONG), ("biHeight", w.LONG),
            ("biPlanes", w.WORD), ("biBitCount", w.WORD),
            ("biCompression", w.DWORD), ("biSizeImage", w.DWORD),
            ("biXPelsPerMeter", w.LONG), ("biYPelsPerMeter", w.LONG),
            ("biClrUsed", w.DWORD), ("biClrImportant", w.DWORD),
        ]

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = width
    bi.biHeight = -height  # top-down
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0

    buf = ctypes.create_string_buffer(width * height * 4)
    gdi32.GetDIBits(mem, bmp, 0, height, buf, ctypes.byref(bi), 0)

    from PIL import Image
    img = Image.frombuffer("RGB", (width, height), buf, "raw", "BGRX", 0, 1)
    img.save(path)

    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(hwnd, hdc)
    return ok, (width, height)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
    wins = find_window()
    if not wins:
        print("NO WINDOW FOUND")
        sys.exit(1)
    hwnd, title = wins[0]
    print("window:", hex(hwnd), repr(title))
    ok, size = capture(hwnd, out)
    print("PrintWindow returned:", ok, "size:", size)
    print("saved:", out)
