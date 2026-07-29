const encodeAsset = (buffer, mediaType) =>
  `data:${mediaType};base64,${Buffer.from(buffer).toString('base64')}`;

const phone = ({ source, label, className = '' }) => `
  <figure class="phone ${className}">
    <div class="speaker" aria-hidden="true"></div>
    <img src="${source}" alt="" />
    <figcaption>${label}</figcaption>
  </figure>
`;

const baseStyles = `
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; }
  body {
    overflow: hidden;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    text-rendering: geometricPrecision;
  }
  .canvas { position: relative; width: 100%; height: 100%; overflow: hidden; }
  .phone {
    position: absolute;
    margin: 0;
    overflow: hidden;
    border: 12px solid #272d29;
    border-radius: 42px;
    background: #101311;
    box-shadow: 0 30px 80px rgb(0 0 0 / 0.28);
  }
  .phone img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .phone figcaption {
    position: absolute;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    min-width: 108px;
    padding: 7px 12px;
    border: 1px solid rgb(255 255 255 / 0.12);
    border-radius: 999px;
    background: rgb(16 19 17 / 0.88);
    color: #f3f5f2;
    font-size: 13px;
    font-weight: 750;
    text-align: center;
    white-space: nowrap;
    backdrop-filter: blur(12px);
  }
  .speaker {
    position: absolute;
    z-index: 2;
    top: 8px;
    left: 50%;
    width: 52px;
    height: 5px;
    transform: translateX(-50%);
    border-radius: 999px;
    background: rgb(243 245 242 / 0.22);
  }
`;

export const createHeroMarkup = ({ icon, home, forecast }) => {
  const iconSource = encodeAsset(icon, 'image/svg+xml');
  const homeSource = encodeAsset(home, 'image/png');
  const forecastSource = encodeAsset(forecast, 'image/png');

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <style>
        ${baseStyles}
        .canvas { background: #101311; color: #f3f5f2; }
        .rail { position: absolute; inset: 0 auto 0 0; width: 18px; background: #64b792; }
        .copy { position: absolute; z-index: 3; top: 136px; left: 104px; width: 600px; }
        .brand { display: flex; align-items: center; gap: 22px; }
        .brand img { width: 82px; height: 82px; border-radius: 22px; }
        .brand strong { font-size: 68px; letter-spacing: -0.055em; }
        h1 { margin: 64px 0 0; max-width: 570px; font-size: 66px; line-height: 1.02; letter-spacing: -0.055em; }
        .detail { margin: 30px 0 0; max-width: 510px; color: #aeb8b1; font-size: 22px; line-height: 1.55; }
        .signal {
          display: inline-flex;
          align-items: center;
          gap: 12px;
          margin-top: 34px;
          padding: 12px 17px;
          border: 1px solid #334039;
          border-radius: 999px;
          color: #c7d1ca;
          font-size: 16px;
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .signal::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: #64b792; }
        .stage {
          position: absolute;
          top: 70px;
          right: 62px;
          width: 790px;
          height: 790px;
          border: 1px solid #27302b;
          border-radius: 52px;
          background: #151916;
        }
        .stage::before, .stage::after {
          content: "";
          position: absolute;
          background: #232a26;
        }
        .stage::before { inset: 50% 0 auto; height: 1px; }
        .stage::after { inset: 0 auto 0 50%; width: 1px; }
        .home { top: 42px; left: 46px; width: 342px; height: 740px; transform: rotate(-2deg); }
        .forecast { top: 42px; right: 46px; width: 342px; height: 740px; transform: rotate(2deg); }
      </style>
    </head>
    <body>
      <main class="canvas">
        <div class="rail" aria-hidden="true"></div>
        <section class="copy">
          <div class="brand"><img src="${iconSource}" alt="" /><strong>Mirna</strong></div>
          <h1>Plan. Track. See what comes next.</h1>
          <p class="detail">A calm, local-first personal finance PWA that keeps the plan, actual activity and forecast distinct.</p>
          <p class="signal">Local-first · Offline-ready</p>
        </section>
        <section class="stage">
          ${phone({ source: homeSource, label: 'Home', className: 'home' })}
          ${phone({ source: forecastSource, label: 'Forecast', className: 'forecast' })}
        </section>
      </main>
    </body>
  </html>`;
};

export const createOverviewMarkup = ({ home, month, forecast }) => {
  const screens = {
    home: encodeAsset(home, 'image/png'),
    month: encodeAsset(month, 'image/png'),
    forecast: encodeAsset(forecast, 'image/png'),
  };

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <style>
        ${baseStyles}
        .canvas { background: #f1f2ee; color: #171a18; }
        header { position: absolute; top: 58px; left: 74px; right: 74px; display: flex; align-items: end; justify-content: space-between; }
        h1 { margin: 0; font-size: 50px; letter-spacing: -0.045em; }
        header p { margin: 0 0 6px; color: #69716c; font-size: 19px; }
        .panels { position: absolute; inset: 145px 62px 48px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
        .panel { position: relative; overflow: hidden; border: 1px solid #d9ddd7; border-radius: 34px; background: #fff; }
        .panel-copy { position: absolute; z-index: 2; top: 30px; left: 32px; }
        .panel-copy span { color: #2f7d64; font-size: 13px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
        .panel-copy h2 { margin: 7px 0 0; font-size: 28px; letter-spacing: -0.035em; }
        .panel .phone { top: 120px; left: 50%; width: 310px; height: 670px; transform: translateX(-50%); }
        .panel:nth-child(2) { background: #17251f; color: #fff; border-color: #17251f; }
        .panel:nth-child(2) .panel-copy span { color: #64b792; }
      </style>
    </head>
    <body>
      <main class="canvas">
        <header>
          <h1>Plan and reality, side by side.</h1>
          <p>Deterministic views from one synthetic local dataset.</p>
        </header>
        <section class="panels">
          <article class="panel">
            <div class="panel-copy"><span>Plan</span><h2>Shape the month</h2></div>
            ${phone({ source: screens.month, label: 'Month' })}
          </article>
          <article class="panel">
            <div class="panel-copy"><span>Actual</span><h2>Know today</h2></div>
            ${phone({ source: screens.home, label: 'Home' })}
          </article>
          <article class="panel">
            <div class="panel-copy"><span>Forecast</span><h2>Look ahead</h2></div>
            ${phone({ source: screens.forecast, label: 'Forecast' })}
          </article>
        </section>
      </main>
    </body>
  </html>`;
};

export const createSocialPreviewMarkup = ({ icon, home, forecast }) => {
  const iconSource = encodeAsset(icon, 'image/svg+xml');
  const homeSource = encodeAsset(home, 'image/png');
  const forecastSource = encodeAsset(forecast, 'image/png');

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <style>
        ${baseStyles}
        .canvas { background: #101311; color: #f3f5f2; }
        .copy { position: absolute; top: 96px; left: 82px; width: 600px; }
        .brand { display: flex; align-items: center; gap: 18px; }
        .brand img { width: 68px; height: 68px; border-radius: 18px; }
        .brand strong { font-size: 57px; letter-spacing: -0.05em; }
        h1 { margin: 46px 0 0; font-size: 48px; line-height: 1.06; letter-spacing: -0.045em; }
        .local { display: flex; align-items: center; gap: 10px; margin-top: 34px; color: #b8c2bb; font-size: 18px; font-weight: 700; }
        .local::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: #64b792; }
        .stage { position: absolute; inset: 34px 36px 34px auto; width: 540px; border: 1px solid #29312d; border-radius: 38px; background: #151916; }
        .home { top: 34px; left: 34px; width: 238px; height: 514px; transform: rotate(-2deg); border-width: 9px; border-radius: 31px; }
        .forecast { top: 34px; right: 34px; width: 238px; height: 514px; transform: rotate(2deg); border-width: 9px; border-radius: 31px; }
        .phone figcaption { display: none; }
      </style>
    </head>
    <body>
      <main class="canvas">
        <section class="copy">
          <div class="brand"><img src="${iconSource}" alt="" /><strong>Mirna</strong></div>
          <h1>Calm personal finance planning, kept on your device.</h1>
          <p class="local">Local-first · Offline PWA</p>
        </section>
        <section class="stage">
          ${phone({ source: homeSource, label: 'Home', className: 'home' })}
          ${phone({ source: forecastSource, label: 'Forecast', className: 'forecast' })}
        </section>
      </main>
    </body>
  </html>`;
};
