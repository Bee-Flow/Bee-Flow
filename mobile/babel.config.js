/**
 * `babel-preset-expo` already wires the React Compiler (enabled in
 * app.config.ts under experiments.reactCompiler) and expo-router's entry.
 *
 * react-native-worklets/plugin MUST stay last in the plugin list —
 * Reanimated 4 moved its worklet transform into the worklets package and the
 * plugin rewrites function bodies, so anything running after it sees already
 * transformed code.
 */
module.exports = function (api) {
    api.cache(true);
    return {
        presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
        plugins: ['react-native-worklets/plugin'],
    };
};
