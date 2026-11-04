// Configuración general. Lo que se cambia a mano está acá.
export const CONFIG = {
  version: '0.8.0',

  // Precio por kWh para calcular el costo de cada carga (en pesos).
  tariff: 150,

  // Los autos y las llaves los crea cada usuario desde la página (se guardan en el servidor).

  // Dirección del servidor en Cloudflare. Con ?demo en la dirección se ven datos simulados.
  server: 'https://diby-ev.mainthorcar.workers.dev',
};
