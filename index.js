const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

// ---------------------------------------------------------------
// 1. YOUR LIBRARY: add titles you have the right to stream
//    (open-licensed films, your own media server, public domain).
//    "id" can be an IMDb id (tt...) so Stremio shows full metadata.
// ---------------------------------------------------------------
const LIBRARY = [
  {
    id: "tt1254207",
    type: "movie",
    name: "Big Buck Bunny",
    year: 2008,
    description: "Open-source animated short by the Blender Foundation (CC BY).",
    poster: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Big_buck_bunny_poster_big.jpg/400px-Big_buck_bunny_poster_big.jpg",
    streams: [
      {
        title: "Direct MP4",
        url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      },
    ],
  },
  {
    id: "tt1727587",
    type: "movie",
    name: "Sintel",
    year: 2010,
    description: "Open-source animated short by the Blender Foundation (CC BY).",
    streams: [
      {
        title: "Direct MP4",
        url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
      },
    ],
  },
  {
    id: "tt2285752",
    type: "movie",
    name: "Tears of Steel",
    year: 2012,
    description: "Open-source sci-fi short by the Blender Foundation (CC BY).",
    streams: [
      {
        title: "Direct MP4",
        url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
      },
    ],
  },
  // Example: your own Jellyfin/Plex/NAS file
  // {
  //   id: "my_home_video_1",
  //   type: "movie",
  //   name: "Family Trip 2024",
  //   streams: [{ title: "Home server", url: "http://192.168.1.10:8096/Videos/xxx/stream.mp4" }],
  // },
];

// ---------------------------------------------------------------
// 2. MANIFEST
// ---------------------------------------------------------------
const manifest = {
  id: "community.my.addon",
  version: "1.0.0",
  name: "My Library",
  description: "Custom addon for Stremio and Nuvio",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "my_"],
  catalogs: [
    {
      type: "movie",
      id: "my-movies",
      name: "My Movies",
      extra: [{ name: "search", isRequired: false }],
    },
  ],
};

const builder = new addonBuilder(manifest);

// ---------------------------------------------------------------
// 3. HANDLERS
// ---------------------------------------------------------------
builder.defineCatalogHandler(({ type, id, extra }) => {
  if (id !== "my-movies") return Promise.resolve({ metas: [] });

  let items = LIBRARY.filter((i) => i.type === type);
  if (extra && extra.search) {
    const q = extra.search.toLowerCase();
    items = items.filter((i) => i.name.toLowerCase().includes(q));
  }

  const metas = items.map((i) => ({
    id: i.id,
    type: i.type,
    name: i.name,
    poster: i.poster,
    releaseInfo: i.year ? String(i.year) : undefined,
  }));
  return Promise.resolve({ metas });
});

builder.defineMetaHandler(({ type, id }) => {
  const item = LIBRARY.find((i) => i.id === id && i.type === type);
  if (!item) return Promise.resolve({ meta: null });
  return Promise.resolve({
    meta: {
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster,
      description: item.description,
      releaseInfo: item.year ? String(item.year) : undefined,
    },
  });
});

builder.defineStreamHandler(({ type, id }) => {
  const item = LIBRARY.find((i) => i.id === id && i.type === type);
  if (!item) return Promise.resolve({ streams: [] });
  return Promise.resolve({
    streams: item.streams.map((s) => ({ title: s.title, url: s.url })),
  });
});

// ---------------------------------------------------------------
// 4. START SERVER
// ---------------------------------------------------------------
const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port });
console.log(`Addon running: http://127.0.0.1:${port}/manifest.json`);
