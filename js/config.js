/* ── config.js ── */
'use strict';

const CONFIG = {
  API_KEY:    (typeof SECRETS !== 'undefined') ? SECRETS.VIETMAP_API_KEY : '',
  MAP_STYLE:  'https://maps.vietmap.vn/maps/styles/tm/style.json',
  ROUTE_API:  'https://maps.vietmap.vn/api/route/v3',
  MATRIX_API: 'https://maps.vietmap.vn/api/matrix/v3',
  SEARCH_API: 'https://maps.vietmap.vn/api/search/v3',
  REVERSE_API:'https://maps.vietmap.vn/api/reverse/v3',
  DEFAULT_CENTER: [106.6755666, 10.7588867], // TP.HCM
  DEFAULT_ZOOM: 12,
  GA: {
    POPULATION_SIZE: 200,
    MAX_GENERATIONS:  500,
    MUTATION_RATE:   0.02,
    ELITE_SIZE:       20,
    TOURNAMENT_SIZE:   5
  }
};
