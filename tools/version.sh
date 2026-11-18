#!/bin/sh
# Uso: sh tools/version.sh 1.0.3  → cambia la versión y obliga a los navegadores a bajar los archivos nuevos
V="$1"
[ -z "$V" ] && echo "Falta la versión" && exit 1
sed -i -E "s/version: '[0-9.]+'/version: '$V'/" js/config.js
sed -i -E "s#href=\"css/app.css(\?v=[0-9.]+)?\"#href=\"css/app.css?v=$V\"#; s#src=\"js/app.js(\?v=[0-9.]+)?\"#src=\"js/app.js?v=$V\"#" index.html
sed -i -E "s#from './(config|sim|remote).js(\?v=[0-9.]+)?'#from './\1.js?v=$V'#" js/app.js
echo "Versión $V"
