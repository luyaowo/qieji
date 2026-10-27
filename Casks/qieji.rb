# The repository and release asset must be public before this cask can be installed.
cask "qieji" do
  version "0.2.5,27"
  sha256 "c952152078d04b00416a73395677e62a6944376b0e12376a11576f9902b34f4d"

  url "https://github.com/luyaowo/qieji/releases/download/v0.2.5/qieji-0.2.5-build27-arm64.dmg"
  name "且记"
  desc "Paper-like to-do list at the edge of your Mac desktop"
  homepage "https://github.com/luyaowo/qieji"

  depends_on arch: :arm64
  depends_on macos: ">= :sonoma"

  app "且记.app"
end
