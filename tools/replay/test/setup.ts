import sodiumImpl from 'libsodium-wrappers-sumo';
import { initSodium, type Sodium } from '@crewmap/p2p';

await initSodium(sodiumImpl as unknown as Sodium);
