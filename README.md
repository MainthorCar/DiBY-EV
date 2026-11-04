# DiBY EV

https://mainthorcar.github.io/DiBY-EV/

**Digital infrastructure for Battery Yield.** Página para ver y manejar en tiempo real el cargador **Schneider EVlink Pro AC (22 kW)**: potencia, fases, batería estimada, programación por porcentaje, tiempo o energía, historial por auto y llaves NFC.

Se ve en PC y en el celular, siempre en una sola pantalla y sin scroll.

## Estado

- [x] Página con datos simulados (modo **DEMO**)
- [x] Servidor propio en Cloudflare que habla OCPP 1.6J con el cargador (se publica solo con cada cambio)
- [ ] Conectar el cargador real
- [ ] App Android que se actualiza sola desde este repo
- [ ] Usuarios de la empresa

## Cómo está armado

```
index.html          la página
css/app.css         estilo (fondo negro, neón verde y azul)
js/app.js           dibujo, gráficos y botones
js/sim.js           cargador simulado para probar
js/config.js        tarifa, autos y dirección del servidor
js/remote.js        conexión con el servidor
server/             servidor en Cloudflare (OCPP 1.6J + datos en vivo)
```

Lo que se cambia a mano (precio del kWh, autos, capacidad de batería) está en `js/config.js`.

## Probar sin el cargador

Agregá `?demo` a la dirección de la página para ver los datos simulados.
