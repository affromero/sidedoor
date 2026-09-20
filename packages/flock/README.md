# Sidedoor native file locking

This package builds the native source from fs-ext 2.1.1 by Matt Sergeant and
contributors under its original MIT license. It retains the OS flock behavior.
Sidedoor uses only the synchronous flock entry point.

The source removes nine process-global V8 persistent string handles used by
statvfs. Their property names are created in the current isolate instead.
This prevents concurrent Node worker initialization from resetting another
isolate's handles. No locking or filesystem operation has been replaced.

Installation requires the same native compiler toolchain as fs-ext. Build output
is produced locally by node-gyp and is not included in the package archive.

Next.js applications must list `thesidedoor-flock` in
`serverExternalPackages` so the server loads the installed native binary instead
of adding it to the application bundle.
