# Third-party and asset notices

This is a source-only distribution. Dependencies and native executables are not
vendored in the Git repository or source ZIP. The lockfile records the resolved
dependency versions. Installing dependencies may download native packages.

| Component | Role | Upstream license / source |
| --- | --- | --- |
| sharp | Decode and normalize source images | Apache-2.0; https://github.com/lovell/sharp |
| libvips and codecs distributed by sharp's optional packages | Native image processing | Separate upstream licenses, including LGPL-2.1-or-later; preserve the notices in installed `@img` packages when redistributing them |
| ffmpeg-static | Locate / download a platform FFmpeg executable | Package: GPL-3.0-or-later; https://github.com/eugeneware/ffmpeg-static |
| FFmpeg executable | Video probing, encoding and composition through a subprocess | License depends on the chosen build and enabled codecs; https://ffmpeg.org/legal.html and the binary distributor's notices apply |
| TypeScript | Build and test tooling | Apache-2.0; https://github.com/microsoft/TypeScript |
| Node.js type definitions | Build tooling | MIT; https://github.com/DefinitelyTyped/DefinitelyTyped |

React, React DOM, React Flow, Tailwind CSS and Lucide are referenced by the canvas
integration source. That source requires a host application and is not included
in the standalone package build. Their upstream licenses apply to those
dependencies when you install and distribute a host application.

The project's Apache-2.0 license does not relicense these dependencies or downloaded
executables. Consult the exact dependency and binary notices before redistributing
a bundled application. Providing your own FFmpeg through `FFMPEG_PATH` does not
change that executable's license.

## Assets

- `docs/images/01-impact-cover.png` and `05-workflow.png`: AI-generated original
  illustrations made for this project's tutorial. The cover is an artistic effect
  illustration, not a screenshot of an automatically generated result.
- `docs/images/02-default-mode.png`, `03-advanced-controls.png` and
  `04-image-editing.png`: screenshots of the original feature with original
  demonstration artwork and sample model configuration. They document the host UI.
- Demo images and video are generated locally by the included script from simple
  geometric shapes; no user film clips or photographs are included.

These project-authored tutorial assets are offered under the repository license
to the extent applicable. MAGINE product marks identify the source product.
