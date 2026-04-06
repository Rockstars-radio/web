const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');
const privacyDistRoot = path.join(distRoot, 'politica-de-privacidad');
const privacyAssetsRoot = path.join(privacyDistRoot, 'assets');

const shareImageSource = path.join(projectRoot, 'assets', 'rockstars-dark-guitar.png');
const whiteLogoSource = path.join(projectRoot, 'assets', 'rockstars-logo-white.png');
const faviconSource = path.join(projectRoot, 'assets', 'rockstars-isotipo.png');
const privacySource = path.join(projectRoot, 'privacy-policy.html');
const socialPreviewTarget = path.join(distRoot, 'social-preview.png');
const privacyTarget = path.join(privacyDistRoot, 'index.html');
const privacyBackgroundTarget = path.join(privacyAssetsRoot, 'rockstars-dark-guitar.png');
const privacyLogoTarget = path.join(privacyAssetsRoot, 'rockstars-logo-white.png');
const privacyFaviconTarget = path.join(privacyAssetsRoot, 'rockstars-isotipo.png');
const indexHtmlPath = path.join(distRoot, 'index.html');

const siteUrl = 'https://rockstars.com.co/';
const privacyUrl = 'https://rockstars.com.co/politica-de-privacidad/';
const socialPreviewUrl = 'https://rockstars.com.co/social-preview.png';
const siteTitle = 'Rockstars Radio';
const siteDescription =
  'La radio que inmortaliza el rock. Escucha la señal en vivo, revisa el historial y pide tus canciones favoritas.';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFile(from, to) {
  fs.copyFileSync(from, to);
}

function injectMetaTags(html) {
  const tags = [
    `<meta name="description" content="${siteDescription}" />`,
    `<meta name="theme-color" content="#050505" />`,
    `<link rel="canonical" href="${siteUrl}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${siteTitle}" />`,
    `<meta property="og:locale" content="es_CO" />`,
    `<meta property="og:title" content="${siteTitle}" />`,
    `<meta property="og:description" content="${siteDescription}" />`,
    `<meta property="og:url" content="${siteUrl}" />`,
    `<meta property="og:image" content="${socialPreviewUrl}" />`,
    `<meta property="og:image:secure_url" content="${socialPreviewUrl}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="800" />`,
    `<meta property="og:image:alt" content="Rockstars Radio - portada para compartir" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${siteTitle}" />`,
    `<meta name="twitter:description" content="${siteDescription}" />`,
    `<meta name="twitter:image" content="${socialPreviewUrl}" />`,
    `<meta name="twitter:url" content="${siteUrl}" />`,
  ].join('\n    ');

  let nextHtml = html.replace('<html lang="en">', '<html lang="es-CO">');

  if (!nextHtml.includes('property="og:title"')) {
    nextHtml = nextHtml.replace('</head>', `    ${tags}\n  </head>`);
  }

  return nextHtml;
}

function injectPrivacyMetaTags(html) {
  const tags = [
    `<link rel="canonical" href="${privacyUrl}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="${siteTitle}" />`,
    `<meta property="og:locale" content="es_CO" />`,
    `<meta property="og:title" content="Política de privacidad | Rockstars Radio" />`,
    `<meta property="og:description" content="Política de privacidad de Rockstars Radio y tratamiento de datos del servicio." />`,
    `<meta property="og:url" content="${privacyUrl}" />`,
    `<meta property="og:image" content="${socialPreviewUrl}" />`,
    `<meta property="og:image:secure_url" content="${socialPreviewUrl}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="800" />`,
    `<meta property="og:image:alt" content="Rockstars Radio - portada para compartir" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="Política de privacidad | Rockstars Radio" />`,
    `<meta name="twitter:description" content="Consulta la política de privacidad de Rockstars Radio." />`,
    `<meta name="twitter:image" content="${socialPreviewUrl}" />`,
  ].join('\n    ');

  if (html.includes('property="og:title"')) {
    return html;
  }

  return html.replace('</head>', `    ${tags}\n  </head>`);
}

ensureDir(privacyAssetsRoot);

copyFile(privacySource, privacyTarget);
copyFile(shareImageSource, privacyBackgroundTarget);
copyFile(whiteLogoSource, privacyLogoTarget);
copyFile(faviconSource, privacyFaviconTarget);
copyFile(shareImageSource, socialPreviewTarget);

const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
fs.writeFileSync(indexHtmlPath, injectMetaTags(indexHtml), 'utf8');

const privacyHtml = fs.readFileSync(privacyTarget, 'utf8');
fs.writeFileSync(privacyTarget, injectPrivacyMetaTags(privacyHtml), 'utf8');

console.log('Postbuild web listo: metadatos sociales e imagen de portada generados.');
