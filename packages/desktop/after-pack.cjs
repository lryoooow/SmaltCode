const fs = require('node:fs');
const path = require('node:path');

/** Embed the canonical icon without winCodeSign/rcedit or symlink privileges. */
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const { NtExecutable, NtExecutableResource, Data, Resource } = await import('resedit');
  const executable = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  const exe = NtExecutable.from(fs.readFileSync(executable), { ignoreCert: true });
  const resources = NtExecutableResource.from(exe);
  const icon = Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'assets/smalt.ico')));
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icon.icons.map(i => i.data));
  for (const version of Resource.VersionInfo.fromEntries(resources.entries)) {
    const [major, minor, patch] = context.packager.appInfo.version.split('.').map(Number);
    version.setFileVersion(major, minor, patch, 0, 1033);
    version.setProductVersion(major, minor, patch, 0, 1033);
    version.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: context.packager.appInfo.productName,
      FileDescription: 'SmaltCode desktop',
      CompanyName: 'SmaltCode contributors',
      InternalName: context.packager.appInfo.productFilename + '.exe',
      OriginalFilename: context.packager.appInfo.productFilename + '.exe',
      LegalCopyright: context.packager.appInfo.copyright,
    });
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(exe);
  const temporary = executable + '.icons.tmp';
  fs.writeFileSync(temporary, Buffer.from(exe.generate()));
  fs.renameSync(temporary, executable);
  console.log('[icons] embedded canonical SmaltCode logo and version in Windows executable');
};
