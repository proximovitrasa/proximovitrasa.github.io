# SPDX-License-Identifier: AGPL-3.0-only
"""Registro de la API de tiempos en vivo de Vitrasa (lo usa el Action registrar-api.yml, tarea 75).

Durante un rato consulta en bucle las paradas de tools/registro-paradas.json y guarda cada
respuesta tal cual la entiende la web (misma decodificación y misma limpieza del asterisco que
fetchEstimates() de app.js), una línea JSON por consulta:
  {"t": segundos UTC, "id": "20193", "est": [{"linea", "ruta", "minutos", "metros"}, …]}
  o {"t": …, "id": …, "error": "…"} si la descarga falla.
Sirve para ver después qué letrero da la API a cada bus y en qué paradas aparece (ramales).

Uso: python3 tools/registrar_api.py <salida.jsonl> <minutos> [segundos entre vueltas]
Solo lee de datos.vigo.org; no escribe nada en el repositorio.
"""
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = "https://datos.vigo.org/vci_api_app/api2.jsp?id={}&ttl=5&tipo=TRANSPORTE-ESTIMACION-PARADA"
HILOS = 4            # consultas a la vez (poca carga para la API)


def decodificar(buf):  # igual que fetchEstimates() de app.js
    try:
        return buf.decode("utf-8")
    except UnicodeDecodeError:
        return buf.decode("cp1252", errors="replace")


def consultar(id_):
    t = round(time.time(), 1)
    try:
        req = urllib.request.Request(URL.format(id_), headers={"User-Agent": "VigoBus-registro/1.0 (pruebas; github.com/proximovitrasa)"})
        with urllib.request.urlopen(req, timeout=25) as r:
            data = json.loads(decodificar(r.read()))
        est = []
        for x in data.get("estimaciones") or []:
            ruta = str(x.get("ruta", "")).replace("*", "").strip()
            est.append({"linea": x.get("linea"), "ruta": ruta, "minutos": x.get("minutos"), "metros": x.get("metros")})
        return {"t": t, "id": id_, "est": est}
    except Exception as e:  # noqa: BLE001 — se registra cualquier fallo y se sigue
        return {"t": t, "id": id_, "error": f"{type(e).__name__}: {e}"[:200]}


def main():
    salida, minutos = Path(sys.argv[1]), float(sys.argv[2])
    vuelta = float(sys.argv[3]) if len(sys.argv) > 3 else 360
    ids = [p["id"] for p in json.loads((ROOT / "tools/registro-paradas.json").read_text())["paradas"]]
    fin = time.time() + minutos * 60
    n = errores = vueltas = 0
    with salida.open("a", encoding="utf-8") as f, ThreadPoolExecutor(HILOS) as pool:
        while time.time() < fin:
            ini = time.time()
            for r in pool.map(consultar, ids):
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
                n += 1
                errores += "error" in r
            f.flush()
            vueltas += 1
            print(f"{time.strftime('%H:%M:%S', time.gmtime())} UTC · vuelta {vueltas} · {n} consultas · {errores} errores", flush=True)
            espera = vuelta - (time.time() - ini)
            if espera > 0 and time.time() + espera < fin:
                time.sleep(espera)
            elif time.time() + max(espera, 0) >= fin:
                break
    print(f"Fin: {vueltas} vueltas, {n} consultas, {errores} errores.")


if __name__ == "__main__":
    main()
