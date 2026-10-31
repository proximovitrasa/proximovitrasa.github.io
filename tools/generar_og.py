"""Imagen para la vista previa al compartir un enlace (WhatsApp, Telegram…): icons/og.png, 1200×630.
Uso (con Playwright): python3 tools/generar_og.py
"""
import base64
from pathlib import Path
from playwright.sync_api import sync_playwright

RAIZ = Path(__file__).resolve().parent.parent
b64 = lambda p: base64.b64encode((RAIZ / p).read_bytes()).decode()
HTML = f"""<style>
@font-face{{font-family:BC;src:url(data:font/woff2;base64,{b64('fonts/BarlowCondensed-Bold.woff2')})}}
@font-face{{font-family:BM;src:url(data:font/woff2;base64,{b64('fonts/Barlow-Medium.woff2')})}}
body{{margin:0;width:1200px;height:630px;background:#F4F1EF;display:flex;align-items:center;gap:64px;padding:0 96px;box-sizing:border-box}}
img{{width:380px;height:380px;filter:drop-shadow(0 16px 32px rgba(94,46,50,.25))}}
h1{{font:72px/1 BC;color:#1B1B1F;margin:0 0 20px}} p{{font:34px/1.3 BM;color:#4A454E;margin:0}}
</style><img src="data:image/svg+xml;base64,{b64('icons/logo.svg')}">
<div><h1>Vitrasa en Vivo</h1><p><span>El bus donde realmente está,</span><br><span>no donde debería estar</span></p></div>"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1200, "height": 630})
    pg.set_content(HTML)
    pg.wait_for_function("document.fonts.ready && document.images[0].complete")
    pg.evaluate("document.fonts.ready")
    # El lema, en dos líneas, del mismo ancho que el título: un bloque que cuadra debajo.
    pg.evaluate("""() => {
      const h = document.querySelector('h1'), p = document.querySelector('p');
      const w = () => Math.max(...[...p.querySelectorAll('span')].map((x) => x.getBoundingClientRect().width));
      p.style.whiteSpace = 'nowrap';
      const r = document.createRange(); r.selectNodeContents(h);
      p.style.fontSize = (34 * r.getBoundingClientRect().width / w()) + 'px';
    }""")
    pg.screenshot(path=str(RAIZ / "icons/og.png"))
    b.close()
print("icons/og.png generado")
