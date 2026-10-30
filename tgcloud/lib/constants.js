export const API_ORIGIN = 'https://www.benaiah.org';

export const SITE_URL = 'https://www.benaiah.org';

// The API itself caches for an hour, so there is no point refetching sooner.
export const CATALOG_TTL_MS = 60 * 60 * 1000;

export const ARTICLE_TTL_MS = 6 * 60 * 60 * 1000;

export const LANGS = ['en', 'am'];

export const ARTICLE_TYPES = ['devotional', 'study_material'];

// A counselor who neither accepts nor declines within this time is skipped.
export const OFFER_TIMEOUT_MS = 10 * 60 * 1000;

export const SUBTOPICS_PER_PAGE = 8;

export const SEARCH_RESULTS = 8;

// Telegram caps a plain message at 4096 characters and a rich message at 32768.
export const TEXT_LIMIT = 4000;

export const RICH_LIMIT = 32000;

// From benaiah.org (home page and /team).
export const SOCIAL_LINKS = {
  channel: 'https://t.me/benaiah_org',
  contact: 'https://t.me/Benaiah_Contact',
  app: 'https://www.benaiah.org/app',
  instagram: 'https://instagram.com/benaiah_org',
  facebook: 'https://facebook.com/BenaiahOrgPage',
  x: 'https://x.com/benaiah_org',
  threads: 'https://threads.net/@benaiah_org',
  linkedin: 'https://linkedin.com/company/banaiah-org',
};

export const TEAM = {
  authors: ['Eden Tesfaye', 'Ablene Melese', 'Bethelem Melese', 'Clinton Beyene', 'Daniel Demerw', 'Hanna Kinfe', 'Hawi Fikru', 'Kibru Abebe', 'Leul Gezahegn', 'Truket Lema'],
  designers: ['Akinahom Getahun', 'Addis Techale', 'Bereket Fikru', 'Eyuel Melese', 'Rebira Tibebu', 'Tinsae Solomon', 'Yisihak Wondimagegn'],
  narrators: ['Courtney Reed', 'Henok Tesfaye'],
  developers: ['Dagmawi Esayas'],
};

// The site's logo files. Their names carry a build hash, so lib/brand.js looks
// up the current ones on the home page and falls back to these.
export const BRAND_ASSETS = [
  { key: 'BenaiahBlack', url: 'https://www.benaiah.org/_app/immutable/assets/BenaiahBlack.CealoO0v.jpg', name: 'Benaiah-logo-white-on-black.jpg', photo: true },
  { key: 'BenaiahWhite', url: 'https://www.benaiah.org/_app/immutable/assets/BenaiahWhite.8FwufcIK.jpg', name: 'Benaiah-logo-black-on-white.jpg', photo: true },
  { key: 'BlackLogo', url: 'https://www.benaiah.org/_app/immutable/assets/BlackLogo.Db4_R73V.png', name: 'Benaiah-logo-transparent.png', photo: false },
];

export const BRAND_TTL_MS = 24 * 60 * 60 * 1000;

// The logo (black on white) shown with the welcome message. If the site renames
// it, the welcome falls back to text until this is updated.
export const WELCOME_PHOTO = BRAND_ASSETS[1].url;
