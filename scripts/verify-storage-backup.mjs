// One real owned-emulator application recovery drill; never adopts remote targets.
try {
  if (process.argv.length !== 2)
    throw new Error("Usage: npm run verify:storage-backup (no arguments)");
  const { runStorageRecoveryDrill } = await import("../apps/server/src/storage-recovery-drill.ts");
  console.log(JSON.stringify(await runStorageRecoveryDrill(), null, 2));
} catch (error) {
  console.error(
    error.message.startsWith("Usage:")
      ? error.message
      : "Storage recovery drill failed. No recovery success claimed; preserve the private synthetic backup input. Credentials and raw SDK errors are not logged.",
  );
  process.exitCode = 1;
}
