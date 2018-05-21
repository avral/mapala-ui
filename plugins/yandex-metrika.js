import Vue from 'vue'
import VueYandexMetrika from 'vue-yandex-metrika'

export default ({ app: { router }}) => {
  Vue.use(VueYandexMetrika, {
    id: 48947042,
    router: router,
    env: 'production'
  })
}
