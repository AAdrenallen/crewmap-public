import sodiumImpl from 'libsodium-wrappers-sumo';
import { initSodium, type Sodium } from '../src/crypto/sodium';

await initSodium(sodiumImpl as unknown as Sodium);
