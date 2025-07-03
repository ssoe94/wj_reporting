module.exports = {
  plugins: [
    require('postcss-import'),
    require('@tailwindcss/postcss'),
    require('postcss-custom-properties')({ preserve: false }),
    require('autoprefixer')({ overrideBrowserslist: ['ie 11'] }),
    require('postcss-flexbugs-fixes'),
  ],
}; 