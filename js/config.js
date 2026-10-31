// Configuración general. Lo que se cambia a mano está acá.
export const CONFIG = {
  version: '0.2.0',

  // Precio por kWh para calcular el costo de cada carga (en pesos).
  tariff: 150,

  // Autos. batteryKWh: capacidad útil de la batería; se usa para estimar el %.
  // Si queda en null, el % se estima con simBatteryKWh hasta que lo carguemos.
  cars: [
    { id: 't1', name: 'Jetour T1 i-DM', color: '#2BFF88', batteryKWh: null },
    { id: 'dolphin', name: 'BYD Dolphin', color: '#19C8FF', batteryKWh: null },
    { id: 'kangoo', name: 'Kangoo E-Tech', color: '#A9B8FF', batteryKWh: null },
  ],
  simBatteryKWh: 26.7,

  // Dirección del servidor en Cloudflare (paso 2). Mientras sea null, la página usa datos simulados.
  server: null,
};
