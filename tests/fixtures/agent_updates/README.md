Test fixtures for agent updates. The keys here are test-only: never in
`app/services/agent_updates/keys.ts` or the kit's `update/keys.go`.

`signify/` was made by the tools themselves on 2026-09-30 in throwaway LXD
containers (`plab-upd-rel-deb`: Debian trixie with signify-openbsd 32;
`plab-upd-rel-2512`: OpenWrt 25.12.5 with usign), deleted afterwards:

    signify-openbsd -G -n -c "Perch test key (signify-openbsd, …)" -p test.pub -s test.sec
    signify-openbsd -S -s test.sec -m manifest.json -x manifest.json.sig
    usign -S -m manifest.json -s test.sec -x manifest.json.usign.sig
    usign -G -s test2.sec -p test2.pub -c "Perch test key 2 (usign, tests only)"
    usign -S -m manifest.json -s test2.sec -x manifest.json.key2.sig

`manifest.tampered.json` differs from `manifest.json` in the version;
`manifest.json.sig.tampered` flips one bit of the signature. `test.sec` has no
passphrase (`-n`) so the tests can sign manifests they build at run time with
the same key (`tests/helpers/agent_updates.ts`).

`signify/kit/` is a byte-identical copy of perch-agentkit's
`update/testdata/signify/` (without its secret keys): the same manifest signed
by signify-openbsd and usign, verified by both implementations.

`versions.json` is a copy of the kit's `update/testdata/versions.json`.
