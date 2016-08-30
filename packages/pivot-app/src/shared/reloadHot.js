import App from './containers/App';
import { BehaviorSubject } from 'rxjs';

export function reloadHot(module) {

    const hotModules = new BehaviorSubject({ App });

    if (module.hot) {
        module.hot.accept([
            './containers/App.js'
        ], () => {
            hotModules.next({
                App: require('./containers/App').default
            });
        })
    }

    return hotModules;
}
