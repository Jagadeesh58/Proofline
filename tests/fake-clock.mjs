const fakeNowEnv = process.env.FAKE_NOW;
if (fakeNowEnv) {
  const fakeTime = Date.parse(fakeNowEnv.includes('T') ? fakeNowEnv : `${fakeNowEnv}T12:00:00Z`);
  const RealDate = globalThis.Date;

  class FakeDateBase extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fakeTime);
      } else {
        super(...args);
      }
    }

    static now() {
      return fakeTime;
    }
  }

  const FakeDate = new Proxy(FakeDateBase, {
    apply(_target, _thisArg, _argList) {
      return new RealDate(fakeTime).toString();
    },
  });

  globalThis.Date = FakeDate;
}
