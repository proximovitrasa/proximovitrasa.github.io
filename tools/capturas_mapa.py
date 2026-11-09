# SPDX-License-Identifier: AGPL-3.0-only
"""Capturas fijas de la web para comprobar que un cambio en el mapa no cambia nada (tareas 41 + 47).

Sirve el repositorio en local, abre cada escena en Chromium (Playwright) en móvil y ordenador con
la hora fija (miércoles 11/11/2026, 10:00 en Vigo), la ubicación fija (Colón / Policarpo Sanz), la
API de tiempos en vivo simulada y las teselas externas bloqueadas (el fondo sale vacío; lo que se
compara es lo nuestro), y guarda una captura por escena. Con --comparar, compara con otra carpeta
y dice cuántos píxeles cambian.

Uso:
  python3 tools/capturas_mapa.py <carpeta>                       # hacer capturas
  python3 tools/capturas_mapa.py <carpeta> --comparar <otra>     # y compararlas
  Opcional: --consulta "mapa=nuevo" añade ?mapa=nuevo a la dirección.
"""
import argparse
import http.server
import json
import socketserver
import sys
import threading
from functools import partial
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HORA = "2026-11-11T10:00:00+01:00"
YO = {"latitude": 42.23725, "longitude": -8.72085}
API = {"estimaciones": [
    {"linea": "C3i", "ruta": "BOUZAS por GARCIA BARBON", "minutos": 4, "metros": 1400},
    {"linea": "C3i", "ruta": "COIA - SAMIL por G. BARBON", "minutos": 21, "metros": 7200},
    {"linea": "A", "ruta": "NAVIA", "minutos": 2, "metros": 600},
    {"linea": "15C", "ruta": "SAMIL por T. ALONSO", "minutos": 7, "metros": 2500},
    {"linea": "14", "ruta": "GRAN VIA", "minutos": 9, "metros": 3100},
    {"linea": "C1", "ruta": "C1", "minutos": 5, "metros": 1800},
]}
ESCENAS = [
    ("inicio", ""),
    ("parada", "#20193"),
    ("linea-desde-parada", "#linea/C3i/20193"),
    ("linea-completa", "#linea/14"),
    ("como-llegar", "#ir/p20193/p1860"),
    ("direccion", "#dir/42.23720,-8.72430~Rúa do Príncipe, 22"),
    ("favoritas", "#favoritas"),
    # Fase 3 (línea abierta): ramales, variante de un letrero, alejada y de cerca.
    ("linea-ramales", "#linea/A/14225"),
    ("linea-variante", "#linea/C3i/20193/BOUZAS%20por%20GARCIA%20BARBON"),
    ("linea-alejada", "#linea/C3i/20193", [42.2290, -8.7380], 13),
    ("linea-cerca", "#linea/14", [42.23767, -8.72127], 16),
    # Fase 4 (buses en vivo): Cómo llegar con el bus de la C3i en camino (y su recorrido).
    ("como-llegar-bus", "#ir/p20193/p14124"),
]
VISTAS = {"movil": {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True},
          "ordenador": {"viewport": {"width": 1366, "height": 820}, "device_scale_factor": 1}}


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def servir():
    srv = socketserver.TCPServer(("127.0.0.1", 0), partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def capturar(salida, consulta):
    salida.mkdir(parents=True, exist_ok=True)
    srv, port = servir()
    errores = []
    with sync_playwright() as p:
        nav = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        for vista, opts in VISTAS.items():
            for esc in ESCENAS + [("zoom-cercano", "#zoom")]:
                nombre, hash_ = esc[0], esc[1]
                vista_mapa = esc[2:] if len(esc) > 2 else None
                ctx = nav.new_context(**opts, locale="es-ES", timezone_id="Europe/Madrid", reduced_motion="reduce",
                                      geolocation=YO, permissions=["geolocation"], service_workers="block")
                ctx.clock.install(time=HORA)
                ctx.add_init_script("try{localStorage.setItem('pv:idioma','es');localStorage.setItem('pv:instalar-oculto','1')}catch(e){}")
                page = ctx.new_page()

                def ruta(route):
                    u = route.request.url
                    if u.startswith(f"http://127.0.0.1:{port}/"):
                        return route.continue_()
                    if "datos.vigo.org" in u:
                        return route.fulfill(status=200, content_type="application/json", body=json.dumps(API))
                    return route.abort()
                page.route("**/*", ruta)
                page.on("pageerror", lambda e, n=nombre, v=vista: errores.append(f"{v}/{n}: {e}"))
                page.on("console", lambda m, n=nombre, v=vista: errores.append(f"{v}/{n}: consola: {m.text}") if m.type == "error" and "ERR_FAILED" not in m.text and "Failed to load resource" not in m.text else None)
                q = f"?{consulta}" if consulta else ""
                if hash_ == "#zoom":
                    page.goto(f"http://127.0.0.1:{port}/{q}#dir/42.23720,-8.72430~Rúa do Príncipe, 22")
                    page.wait_for_timeout(2500)
                    page.evaluate("window.__pvTest && window.__pvTest.view([42.2372,-8.7243], 18)")
                else:
                    page.goto(f"http://127.0.0.1:{port}/{q}{hash_}")
                page.clock.run_for(6000)
                page.wait_for_timeout(3500)
                if vista_mapa:
                    page.evaluate(f"window.__pvTest.focus({list(vista_mapa[0])}, {vista_mapa[1]})")
                    page.wait_for_timeout(1500)
                page.clock.run_for(1500)
                page.wait_for_timeout(800)
                page.screenshot(path=str(salida / f"{vista}-{nombre}.png"))
                ctx.close()
        nav.close()
    srv.shutdown()
    (salida / "errores.txt").write_text("\n".join(errores) + ("\n" if errores else ""))
    print(f"{len(list(salida.glob('*.png')))} capturas en {salida}; {len(errores)} errores en la consola")
    for e in errores[:20]:
        print("  ", e)


def comparar(a, b):
    from PIL import Image, ImageChops
    peor = 0
    for f in sorted(x for x in a.glob("*.png") if not x.name.startswith("dif-")):
        g = b / f.name
        if not g.exists():
            print(f"  {f.name}: falta en {b}")
            continue
        x, y = Image.open(f).convert("RGB"), Image.open(g).convert("RGB")
        if x.size != y.size:
            print(f"  {f.name}: tamaño distinto {x.size} / {y.size}")
            peor = max(peor, 100)
            continue
        d = ImageChops.difference(x, y).convert("L").point(lambda v: 255 if v > 24 else 0)
        n = sum(d.histogram()[255:])
        pct = 100 * n / (x.size[0] * x.size[1])
        peor = max(peor, pct)
        print(f"  {f.name}: {n} píxeles distintos ({pct:.3f} %)")
        if n:
            d.save(b / f"dif-{f.name}")
    return peor


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("carpeta")
    ap.add_argument("--comparar")
    ap.add_argument("--consulta", default="")
    a = ap.parse_args()
    capturar(Path(a.carpeta), a.consulta)
    if a.comparar:
        print("Comparación:")
        peor = comparar(Path(a.comparar), Path(a.carpeta))
        sys.exit(1 if peor > 0.05 else 0)
