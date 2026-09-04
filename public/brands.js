/**
 * RabbitReminder — 中国大陆主流银行 / 网站会员品牌预设
 * 供表单“主流服务选择”使用；每个品牌带官方主色，自动应用到卡片边框/头像。
 * 未命中预设时走“其他”手动输入。
 */
window.MYREMINDER_BRANDS = (() => {
  // key 仅作内部标识，值任意；选中后自动填入名称与颜色
  const banks = [
    { key: 'icbc', name: '工商银行', color: '#c7000b' },
    { key: 'abc', name: '农业银行', color: '#00a550' },
    { key: 'boc', name: '中国银行', color: '#b01f24' },
    { key: 'ccb', name: '建设银行', color: '#0066b3' },
    { key: 'bocom', name: '交通银行', color: '#1a3c8a' },
    { key: 'psbc', name: '邮储银行', color: '#007f4f' },
    { key: 'cmb', name: '招商银行', color: '#d71920' },
    { key: 'spdb', name: '浦发银行', color: '#0072bc' },
    { key: 'citic', name: '中信银行', color: '#b8152e' },
    { key: 'cib', name: '兴业银行', color: '#0a65b8' },
    { key: 'cmbc', name: '民生银行', color: '#0069b4' },
    { key: 'ceb', name: '光大银行', color: '#9b1c2f' },
    { key: 'pingan', name: '平安银行', color: '#f36c21' },
    { key: 'hxb', name: '华夏银行', color: '#da291c' },
    { key: 'cgb', name: '广发银行', color: '#b11a24' },
    { key: 'czbank', name: '浙商银行', color: '#b02a30' },
    { key: 'hfb', name: '恒丰银行', color: '#b02a30' },
    { key: 'cbhb', name: '渤海银行', color: '#0a7ec2' },
    { key: 'bob', name: '北京银行', color: '#e40135' },
    { key: 'bos', name: '上海银行', color: '#0a4da3' },
    { key: 'njcb', name: '南京银行', color: '#0b57a4' },
    { key: 'nbcb', name: '宁波银行', color: '#e60012' },
    { key: 'jsb', name: '江苏银行', color: '#c40000' },
    { key: 'hsb', name: '徽商银行', color: '#0f6cb6' },
  ];

  const sites = [
    { key: 'bilibili', name: '哔哩哔哩', color: '#fb7299' },
    { key: 'iqiyi', name: '爱奇艺', color: '#00be06' },
    { key: 'youku', name: '优酷', color: '#22acec' },
    { key: 'tencent-video', name: '腾讯视频', color: '#ff5a33' },
    { key: 'mgtv', name: '芒果TV', color: '#ff8a00' },
    { key: 'qqmusic', name: 'QQ音乐', color: '#31c27c' },
    { key: 'netease-music', name: '网易云音乐', color: '#d43c33' },
    { key: 'kugou', name: '酷狗音乐', color: '#2b9bff' },
    { key: 'wps', name: 'WPS会员', color: '#f23d54' },
    { key: 'baidu-pan', name: '百度网盘', color: '#1683ff' },
    { key: 'quark', name: '夸克网盘', color: '#5d6bff' },
    { key: 'thunder', name: '迅雷会员', color: '#0a90ff' },
    { key: 'jd-plus', name: '京东PLUS', color: '#e1251b' },
    { key: 'taobao-88vip', name: '淘宝88VIP', color: '#ff5000' },
    { key: 'pdd', name: '拼多多会员', color: '#e02e24' },
    { key: 'sam', name: '山姆会员', color: '#0066a1' },
    { key: 'hema', name: '盒马X会员', color: '#00a0e9' },
    { key: 'meituan', name: '美团会员', color: '#ffb600' },
    { key: 'eleme', name: '饿了么超级吃货卡', color: '#0089ff' },
    { key: 'weread', name: '微信读书', color: '#07c160' },
    { key: 'ximalaya', name: '喜马拉雅', color: '#f86422' },
    { key: 'keep', name: 'Keep会员', color: '#35c2a6' },
  ];

  const lookup = (list, key) => list.find((item) => item.key === key) || null;
  const byName = (list, name) => list.find((item) => item.name === name) || null;

  return { banks, sites, lookup, byName };
})();
