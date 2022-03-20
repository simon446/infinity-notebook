const CopyWebpackPlugin = require("copy-webpack-plugin");
const path = require('path');

module.exports = {
  entry: "./bootstrap.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "bootstrap.js",
  },
  mode: "development",
  plugins: [
    new CopyWebpackPlugin([
      'index.html',
      'favicon.ico',
      'favicon-32x32.png',
      'favicon-16x16.png',
      'apple-touch-icon.png',
    ])
  ],
};
