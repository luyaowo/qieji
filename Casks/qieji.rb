# The repository and release asset must be public before this cask can be installed.
cask "qieji" do
  version "0.2.4,26"
  sha256 "b5f9c5ac9f145762a6cc42e461c4e57984ec443c3f610f6de633477821f88735"

  url "https://github.com/luyaowo/qieji/releases/download/v0.2.4/%E4%B8%94%E8%AE%B0-Mac-0.2.4-%E6%9E%84%E5%BB%BA26-Apple%E8%8A%AF%E7%89%87.dmg"
  name "且记"
  desc "Paper-like to-do list at the edge of your Mac desktop"
  homepage "https://github.com/luyaowo/qieji"

  depends_on arch: :arm64
  depends_on macos: ">= :sonoma"

  app "且记.app"
end
