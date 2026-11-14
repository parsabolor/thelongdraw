// The minimap's icons: the cells of assets/ui/map-icons.png, one row of squares in this order (the order of `Icon` in the engine's crates/engine/src/minimap.rs and of ICONS in its
// tools/map-icons.html, which bakes the picture; their sources and licences are in assets/ui/CREDITS.md). Each is a white silhouette in a dark edge, so a tint colours the silhouette.
export const MAP_ICONS = ['player', 'bike', 'walker', 'armored', 'scout', 'battery', 'arrow', 'arrows'];

// The icon a zombie is drawn as: binoculars for a scout, a vest for the armored zombie, a shambling figure for any other.
export const zombieIcon = (z) => (z.kind === 'scout' || z.kind === 'armored' ? z.kind : 'walker');
