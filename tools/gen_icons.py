"""アプリアイコンを作る。python3 tools/gen_icons.py"""
from PIL import Image, ImageDraw, ImageFont
BG=(10,20,32); GRN=(56,224,123); CYN=(61,245,255); DIM=(125,147,168)
def font(sz):
    for p in ["/System/Library/Fonts/SFNSMono.ttf","/System/Library/Fonts/Menlo.ttc"]:
        try: return ImageFont.truetype(p, sz)
        except OSError: pass
    return ImageFont.load_default()
def make(size, safe=1.0):
    im=Image.new("RGB",(size,size),BG); d=ImageDraw.Draw(im)
    s=size*safe; o=(size-s)/2
    # 雲の上に稲妻を置かず、文字だけで判別できる形にする(16pxでも潰れない)
    d.text((size/2,o+s*0.42),"WX",font=font(int(s*0.42)),fill=GRN,anchor="mm")
    d.text((size/2,o+s*0.74),"BRF",font=font(int(s*0.17)),fill=CYN,anchor="mm")
    d.line([(o+s*0.18,o+s*0.62),(o+s*0.82,o+s*0.62)],fill=DIM,width=max(1,int(s*0.012)))
    return im
make(192).save("icon-192.png"); make(512).save("icon-512.png"); make(180).save("icon-180.png")
make(512,0.78).save("icon-512-maskable.png")  # ⚠ Androidは円に切り抜くので中央80%に収める
