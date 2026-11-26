import { memo } from 'react';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';

/** Stroke icon set on a 24-unit grid (2 px stroke, round caps), drawn with react-native-svg. */
const P = {
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  crew: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.8c2 .7 3.2 2.5 3.5 5.2'],
  trophy: ['M8 4h8v5a4 4 0 0 1-8 0V4z', 'M8 6H5a3 3 0 0 0 3 4', 'M16 6h3a3 3 0 0 1-3 4', 'M12 13v4', 'M8.5 20h7', 'M10 17h4v3h-4z'],
  car: ['M5 16V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4', 'M3.5 12h17v4.5h-17z', 'M6 16.5V19', 'M18 16.5V19', 'M7 14.2h1', 'M16 14.2h1'],
  pin: ['M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z', 'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  locate: ['M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3'],
  ghost: ['M5 20V10a7 7 0 0 1 14 0v10l-2.3-1.6L14.3 20 12 18.4 9.7 20l-2.4-1.6L5 20z', 'M9.5 10.5h.01', 'M14.5 10.5h.01'],
  back: ['M15 5l-7 7 7 7'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  chevron: ['M9 5l7 7-7 7'],
  chat: ['M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.2A2.5 2.5 0 0 1 4 13.5v-8z'],
  send: ['M4 12l16-8-6 16-2.5-6.5L4 12z', 'M11.5 13.5L20 4'],
  compass: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M15.5 8.5l-2 5-5 2 2-5 5-2z'],
  battery: ['M3 8h15v8H3z', 'M21 11v2'],
  bolt: ['M13 2L4.5 13.5H12L11 22l8.5-11.5H12L13 2z'],
  camera: ['M3 8.5A2.5 2.5 0 0 1 5.5 6H7l1.5-2h7L17 6h1.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-9z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  share: ['M12 15V3', 'M7.5 7.5L12 3l4.5 4.5', 'M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7'],
  plus: ['M12 5v14', 'M5 12h14'],
  qr: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h2v2h-2z', 'M18 14h2', 'M14 18h2v2', 'M18 17v3h2'],
  person: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 21c.7-4 3.6-6.5 7.5-6.5s6.8 2.5 7.5 6.5'],
  store: ['M4 9l1.5-5h13L20 9', 'M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9', 'M5.5 11.5V20h13v-8.5', 'M10 20v-5h4v5'],
  home: ['M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1v-9.5z'],
  alert: ['M12 3.5L2.5 20h19L12 3.5z', 'M12 10v4', 'M12 17h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  route: ['M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M8 17h7.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H16'],
  shuffle: ['M16 3h5v5', 'M4 20L21 3', 'M21 16v5h-5', 'M15 15l6 6', 'M4 4l5 5'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z', 'M10 20.5a2 2 0 0 0 4 0'],
  bellOff: ['M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z', 'M10 20.5a2 2 0 0 0 4 0', 'M3.5 3.5l17 17'],
  motion: ['M13 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M7 21l3-6 3 2v5', 'M10 15l1-6 3 3h4', 'M11 9l-4 1-1 3'],
  wave: ['M7 11.5V6a1.5 1.5 0 0 1 3 0v5', 'M10 10V4.5a1.5 1.5 0 0 1 3 0V10', 'M13 10V5.5a1.5 1.5 0 0 1 3 0V12', 'M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L4 15.2a1.5 1.5 0 0 1 2.3-1.9L7 14.2v-2.7'],
  shield: ['M12 3l7.5 3v5.5c0 4.5-3.2 8.3-7.5 9.5-4.3-1.2-7.5-5-7.5-9.5V6L12 3z', 'M9 12l2 2 4-4'],
  star: ['M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8L12 3.5z'],
  thumbUp: ['M7 11v9H4.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1H7z', 'M7 11l3.5-7a2 2 0 0 1 2 2.2L12 9.5h5.7a2 2 0 0 1 2 2.3l-1.2 6.5a2 2 0 0 1-2 1.7H7'],
  thumbDown: ['M7 13V4H4.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1H7z', 'M7 13l3.5 7a2 2 0 0 0 2-2.2L12 14.5h5.7a2 2 0 0 0 2-2.3l-1.2-6.5a2 2 0 0 0-2-1.7H7'],
  trash: ['M4 7h16', 'M9 7V4.5h6V7', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  sliders: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'],
  chevronDown: ['M5 9l7 7 7-7'],
  link: ['M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4L11.5 6', 'M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.5-1.4'],
  chevronRight: ['M9 6l6 6-6 6'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  user: ['M20 21a8 8 0 0 0-16 0', 'M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z'],
  volume: ['M11 5L6 9H2v6h4l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M19 5a10 10 0 0 1 0 14'],
  popup: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  warning: ['M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M23 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
  eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  globe: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M2 12h20', 'M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z'],
  cloud: ['M17.5 19H8a6 6 0 1 1 1.3-11.9A7 7 0 0 1 22 12.5 4.5 4.5 0 0 1 17.5 19z', 'M12 16v-6', 'M9.5 12.5L12 10l2.5 2.5'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  flame: ['M12 22c4 0 7-2.7 7-7 0-4-3-6.5-4-10-2 1.5-3 3.5-3 5.5C10.5 9 9.5 8 9 6.5 6.5 9 5 11.8 5 15c0 4.3 3 7 7 7z'],
  road: ['M4 21L9 3', 'M20 21L15 3', 'M12 4v2', 'M12 10v3', 'M12 17v3'],
  walk: ['M13 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M10 22l2-7 3 3v4', 'M9 13l1-5 4 1 2 3h3', 'M10 8L6 10v3'],
  speed: ['M12 14l4-4', 'M3.3 19a10 10 0 1 1 17.4 0', 'M12 14h.01'],
  city: ['M3 21h18', 'M5 21V8l6-3v16', 'M11 21V10l8 3v8', 'M8 10v.01', 'M8 14v.01', 'M15 15v.01', 'M15 18v.01'],
  brake: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M8 12h8'],
  accel: ['M13 2L3 14h9l-1 8 10-12h-9z'],
  corner: ['M4 20v-7a7 7 0 0 1 7-7h9', 'M16 2l4 4-4 4'],
  phone: ['M7 2h10v20H7z', 'M11 18h2'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  crash: ['M12 2l2 6 6-2-3 5 5 3-6 1 1 7-5-4-4 4v-6l-6-1 5-3-3-5 6 2z'],
  sparkle: ['M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z', 'M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z'],
  home2: ['M2 11l6-5 6 5', 'M4 9.5V20h8V9.5', 'M7 20v-4h2v4', 'M14 8.5L17.5 5.5 22 9.5', 'M20 8v12h-6'],
  family: ['M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M2.5 21v-3a5.5 5.5 0 0 1 11 0v3', 'M17 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M15 21v-3.5a4 4 0 0 1 6.5-3.1V21'],
  friendPlace: ['M3 10.5L12 3l9 7.5', 'M5 9v12h14V9', 'M12 18.5l-2.6-2.6a1.6 1.6 0 0 1 2.6-2 1.6 1.6 0 0 1 2.6 2z'],
  work: ['M3 7h18v13H3z', 'M8 7V4h8v3', 'M3 13h18'],
  school: ['M22 9L12 4 2 9l10 5z', 'M6 11v5c3 2.5 9 2.5 12 0v-5', 'M22 9v6'],
  gym: ['M6.5 6.5v11', 'M17.5 6.5v11', 'M3 9.5v5', 'M21 9.5v5', 'M6.5 12h11'],
  heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z'],
  food: ['M3 2v7a3 3 0 0 0 6 0V2', 'M6 2v20', 'M21 15V2a5 5 0 0 0-5 5v6h5z', 'M21 15v7'],
  shop: ['M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z', 'M3 6h18', 'M16 10a4 4 0 0 1-8 0'],
  tree: ['M12 22v-6', 'M12 2l7 10h-4l4 5H5l4-5H5z'],
  feather: ['M20.2 12.2a6 6 0 0 0-8.5-8.5L5 10.5V19h8.5z', 'M16 8L2 22', 'M17.5 15H9'],
  owl: ['M12 21c-5 0-8-3-8-8V5l3 2a8 8 0 0 1 10 0l3-2v8c0 5-3 8-8 8z', 'M9 12a1.5 1.5 0 1 0 0-.01', 'M15 12a1.5 1.5 0 1 0 0-.01', 'M11 15l1 1 1-1'],
  sunrise: ['M17 18a5 5 0 0 0-10 0', 'M12 2v7', 'M4.2 10.2l1.4 1.4', 'M1 18h2', 'M21 18h2', 'M18.4 11.6l1.4-1.4', 'M23 22H1', 'M8 6l4-4 4 4'],
  butter: ['M3 15l9-6 9 6-9 6z', 'M3 15v-3l9-6 9 6v3'],
  chart: ['M3 3v18h18', 'M7 15l4-4 3 3 5-6'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  // Ride picker glyphs (ui/avatar/avatarParts RIDE_ICON)
  rideTruck: ['M3 15.5V8h8v7.5', 'M11 10.5h5l3.5 3.5v1.5', 'M2.5 15.5h19', 'M7 19.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M17 19.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  rideSuv: ['M3 16v-4.5L5 7h11l3.5 4.5H21V16', 'M3 16h18', 'M5 11.5h14.5', 'M11 7v4.5', 'M7 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M17 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  rideSports: ['M2.5 15.5V13l4-1.5 3-3h5.5l4.5 3.5 2 .5v3', 'M2.5 15.5h19', 'M7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M17 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  rideVan: ['M3 16V7.5A1.5 1.5 0 0 1 4.5 6H15l4.5 5H21v5z', 'M15 6v5h4.5', 'M3 11h12', 'M7 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M17 18.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  rideConvertible: ['M2.5 15.5V12h5l2-2.5', 'M7.5 12h14v3.5', 'M2.5 15.5h19', 'M7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M17 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  rideMoto: ['M5.5 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18.5 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M5.5 15l4-5h5l4 5', 'M14.5 10L13 7h-2.5', 'M9.5 10l2 5h2'],
  rideHotdog: ['M4.5 15.5a3 3 0 0 1 0-6h15a3 3 0 0 1 0 6z', 'M3 12.5h18', 'M6.5 11c1.2.8 2.3.8 3.5 0s2.3-.8 3.5 0 2.3.8 3.5 0'],
  rideSkate: ['M3 13h18', 'M3 13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2', 'M7.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M16.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'],
  rideScooter: ['M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M8 17h8l1-12h2.5', 'M15 5h4'],
  rideRocket: ['M12 2.5c3 2 4.5 5.5 4.5 9.5l-1.5 4H9l-1.5-4c0-4 1.5-7.5 4.5-9.5z', 'M12 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M7.5 12L5 15v3l4-2', 'M16.5 12L19 15v3l-4-2', 'M10.5 19l1.5 3 1.5-3'],
  rideCart: ['M2 4h3l2.5 11h11L21 8H6.5', 'M9 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M17 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'],
  rideBath: ['M2.5 12h19', 'M4 12v3a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4v-3', 'M6 12V5.5A2.5 2.5 0 0 1 10.5 4', 'M7 19l-1 2', 'M17 19l1 2'],
  rideCarpet: ['M4 9c2.7-1.5 5.3 1.5 8 0s5.3 1.5 8 0', 'M4 15c2.7-1.5 5.3 1.5 8 0s5.3 1.5 8 0', 'M4 9v6', 'M20 9v6', 'M3 17.5l1-2.5', 'M21 17.5l-1-2.5'],
} satisfies Record<string, string[]>;

export type IconName = keyof typeof P;

/** Icons drawn as filled glyphs rather than outlines. */
const FILLED: Partial<Record<IconName, true>> = { bolt: true };

export const Icon = memo(function Icon({ name, size = 24, color, strokeWidth = 2, fill }: { name: IconName; size?: number; color: string; strokeWidth?: number; fill?: string }) {
  const filled = FILLED[name];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {P[name].map((d, i) => (
        <Path key={i} d={d} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill={filled ? color : i === 0 && fill ? fill : 'none'} />
      ))}
    </Svg>
  );
});

/** Battery glyph with a live fill level, coloured by charge. */
export const BatteryIcon = memo(function BatteryIcon({ pct, charging, size = 18, color }: { pct: number; charging?: boolean; size?: number; color: string }) {
  const level = Math.max(0, Math.min(100, pct));
  const tint = charging ? '#22A06B' : level <= 15 ? '#E5484D' : level <= 30 ? '#F5A524' : color;
  return (
    <Svg width={size * 1.4} height={size} viewBox="0 0 28 20">
      <Rect x={1} y={3} width={22} height={14} rx={3.5} stroke={color} strokeWidth={1.8} fill="none" opacity={0.7} />
      <Rect x={24.5} y={7.5} width={2} height={5} rx={1} fill={color} opacity={0.7} />
      <Rect x={3.5} y={5.5} width={Math.max(1.5, 17 * (level / 100))} height={9} rx={1.8} fill={tint} />
      {charging && <Path d="M13 4.5L9 11h3.2l-1 4.5L15.5 9h-3.3L13 4.5z" fill="#FFFFFF" />}
    </Svg>
  );
});

/** Presence dot: online (fresh fix), stale, or paused. */
export const PresenceDot = memo(function PresenceDot({ state, size = 12, ring }: { state: 'live' | 'stale' | 'off'; size?: number; ring: string }) {
  const c = state === 'live' ? '#22A06B' : state === 'stale' ? '#F5A524' : '#8A93A8';
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12">
      <Circle cx={6} cy={6} r={5.2} fill={c} stroke={ring} strokeWidth={1.6} />
    </Svg>
  );
});

/** Icon inside a tinted rounded tile (settings rows, stat tiles, legends). */
export function IconTile({ name, color, size = 36 }: { name: IconName; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Path d="M10 0h16a10 10 0 0 1 10 10v16a10 10 0 0 1-10 10H10A10 10 0 0 1 0 26V10A10 10 0 0 1 10 0z" fill={color} />
      {/* A group transform, not a nested <Svg x y>: react-native-svg on Android ignores nested x/y (icon drew top-left). */}
      <G transform="translate(7 7) scale(0.9167)">
        {P[name].map((d, i) => (
          <Path key={i} d={d} stroke="#FFFFFF" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        ))}
      </G>
    </Svg>
  );
}
