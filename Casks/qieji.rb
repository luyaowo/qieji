# The repository and release asset must be public before this cask can be installed.
cask "qieji" do
  version "0.2.6,28"
  sha256 "e7628e60072354c7ee73a7ecac6c7b4bc8316c9dca3e83be39ecafebe2edbf31"

  url "https://github.com/luyaowo/qieji/releases/download/v0.2.6/qieji-0.2.6-build28-arm64.dmg"
  name "且记"
  desc "Paper-like to-do list at the edge of your Mac desktop"
  homepage "https://github.com/luyaowo/qieji"

  depends_on arch: :arm64
  depends_on macos: ">= :sonoma"

  app "且记.app"
end
