# SPDX-License-Identifier: AGPL-3.0-only
"""Un trozo del registro de la semana (lo usa registrar-semana.yml, control de calidad de la tarea 75).

Cada trabajo del Action dura como mucho TOPE minutos (GitHub corta a las 6 h) y registra la API
con registrar_api.py durante todo ese rato, de día y de noche (también los búhos y los usos
nocturnos). Los trabajos van uno detrás de otro sin huecos, aunque alguno acabe antes de tiempo.

Uso: python3 tools/registrar_semana.py <salida.jsonl> <último día AAAA-MM-DD>
El registro acaba a las 24:00 (hora de Vigo) del último día.
Deja en registro/dia.txt el día (hora de Vigo) en que empezó este trozo.
"""
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

VIGO = ZoneInfo("Europe/Madrid")
TOPE = 340 * 60                    # segundos de trabajo de este trozo


def main():
    salida, ultimo = sys.argv[1], datetime.strptime(sys.argv[2], "%Y-%m-%d")
    fin_semana = (ultimo + timedelta(days=1)).replace(tzinfo=VIGO).timestamp()
    limite = min(time.time() + TOPE, fin_semana)
    (Path(salida).parent / "dia.txt").write_text(datetime.now(VIGO).date().isoformat())
    while True:
        ahora = time.time()
        if ahora >= limite - 30:
            break
        minutos = (limite - ahora) / 60
        print(f"Registrando {minutos:.0f} min", flush=True)
        subprocess.run([sys.executable, str(Path(__file__).with_name("registrar_api.py")), salida, f"{minutos:.2f}"], check=False)
        if time.time() - ahora < 60:                   # si falla al arrancar, no reintentar sin pausa
            time.sleep(60)
    print("Fin del trozo." + ("" if time.time() < fin_semana else " Fin de la semana."))


if __name__ == "__main__":
    main()
