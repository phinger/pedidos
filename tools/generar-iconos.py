#!/usr/bin/env python3
"""Genera los PNG de la app sin dependencias externas.

Dibuja una bolsa de compras blanca sobre el naranja de la marca, con
antialiasing por supersampling. Ejecutar desde la raíz del repo:

    python3 tools/generar-iconos.py
"""
import math
import struct
import zlib
from pathlib import Path

FONDO = (0xD9, 0x4A, 0x24)
TINTA = (0xFF, 0xFF, 0xFF)
SALIDA = Path(__file__).resolve().parent.parent / "docs" / "icons"
MUESTRAS = 4  # subpíxeles por eje


def escribir_png(ruta, ancho, alto, filas_rgb):
    crudo = b"".join(b"\x00" + fila for fila in filas_rgb)

    def trozo(tipo, datos):
        return (struct.pack(">I", len(datos)) + tipo + datos +
                struct.pack(">I", zlib.crc32(tipo + datos) & 0xFFFFFFFF))

    cabecera = struct.pack(">IIBBBBB", ancho, alto, 8, 2, 0, 0, 0)
    ruta.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + trozo(b"IHDR", cabecera)
        + trozo(b"IDAT", zlib.compress(crudo, 9))
        + trozo(b"IEND", b"")
    )


def dentro_de_la_bolsa(x, y, escala):
    """Coordenadas en un lienzo de referencia de 512x512."""
    x, y = x / escala, y / escala

    # Cuerpo: rectángulo con esquinas redondeadas.
    x0, y0, x1, y1, r = 148.0, 196.0, 364.0, 386.0, 30.0
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    if x0 <= x <= x1 and y0 <= y <= y1 and math.hypot(x - cx, y - cy) <= r:
        return True

    # Asa: media corona por encima del cuerpo.
    d = math.hypot(x - 256.0, y - 198.0)
    if y < 198.0 and 42.0 <= d <= 66.0:
        return True

    return False


def generar(tamano, margen=0.0):
    """margen: fracción del lado reservada como zona segura (íconos maskable)."""
    escala = (tamano * (1.0 - 2 * margen)) / 512.0
    desplazamiento = tamano * margen
    paso = 1.0 / MUESTRAS
    filas = []

    for py in range(tamano):
        fila = bytearray()
        for px in range(tamano):
            dentro = 0
            for sy in range(MUESTRAS):
                y = py + (sy + 0.5) * paso - desplazamiento
                for sx in range(MUESTRAS):
                    x = px + (sx + 0.5) * paso - desplazamiento
                    if dentro_de_la_bolsa(x, y, escala):
                        dentro += 1
            k = dentro / (MUESTRAS * MUESTRAS)
            for canal in range(3):
                fila.append(round(FONDO[canal] + (TINTA[canal] - FONDO[canal]) * k))
        filas.append(bytes(fila))
    return filas


def main():
    SALIDA.mkdir(parents=True, exist_ok=True)
    trabajos = [
        ("icon-192.png", 192, 0.0),
        ("icon-512.png", 512, 0.0),
        ("apple-touch-icon.png", 180, 0.0),
        # Android recorta hasta un 20% por lado en los íconos maskable.
        ("icon-maskable-512.png", 512, 0.14),
    ]
    for nombre, tamano, margen in trabajos:
        destino = SALIDA / nombre
        escribir_png(destino, tamano, tamano, generar(tamano, margen))
        print(f"{nombre:26} {tamano}x{tamano}  {destino.stat().st_size:>6} bytes")


if __name__ == "__main__":
    main()
