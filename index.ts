import { registerRootComponent } from 'expo';

// Background location task must be registered before the app mounts.
import './packages/ui/src/wiring/backgroundLocationTask';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
registerRootComponent(App);
